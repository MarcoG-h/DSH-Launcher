// SKILL management: a canonical *library* plus per-instance assignments.
//
// dsh user-level skills live in `<home>/skills` as directory bundles
// `<name>/SKILL.md` or flat `<name>.md`; dsh watches that directory (chokidar)
// and refreshes its catalog on add/remove — no instance restart is needed.
// dsh has no native "disable": a skill is simply whatever sits in `skills/`. So
// enable/disable is a physical move between `<home>/skills` (enabled) and
// `<home>/.skill-off` (disabled, outside the watched root → hot-unloads).
//
// Since 2026-09 skills follow the plugin "library + matrix" model: every skill
// is first *stored* in the skill library `<runtimeRoot>/skill-library/<name>`
// (the only install target — market / repo / drop / paste all write there), then
// *assigned* to instances by copying from the library into an instance home.
// Editing a library record re-pushes every assigned instance's copy (keeping its
// enabled/disabled shelf state); deleting a library record removes the copy from
// every instance.
//
// Repo-sourced skills record their origin (repo URL + commit/tag) in a
// `.dsh-skill.json` inside the bundle so they can be updated later by
// comparing the recorded commit with the remote HEAD.

import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as yaml from 'js-yaml'
import { BrowserWindow, dialog, net, type OpenDialogOptions } from 'electron'
import { getConfig } from './config'
import { ensureInstanceHome, getInstance, getInstances, instanceDshHome } from './instances'
import { t } from './i18n'
import type { SkillInfo, SkillOrigin, RepoSkillInfo, SkillUpdateInfo, SkillMarketRepo, SkillRepoCandidate, SkillPolicyPatch } from '../shared/types'

/** Disabled skill shelf: sibling of `skills/` under the same home. */
const SKILL_OFF_DIR = '.skill-off'
const SKILL_META = '.dsh-skill.json'

// --- path helpers ---

/** The skill library root: canonical store of every skill (sibling of `homes/`). */
export function skillLibraryRoot(): string {
  return join(getConfig().runtimeRoot, 'skill-library')
}

function homeOf(instanceId: string): string {
  const inst = getInstance(instanceId)
  if (!inst) throw new Error(t(`实例不存在: ${instanceId}`, `Unknown instance: ${instanceId}`))
  return ensureInstanceHome(inst)
}

const enabledDir = (home: string): string => join(home, 'skills')
const disabledDir = (home: string): string => join(home, SKILL_OFF_DIR)

// --- frontmatter ---

interface ParsedSkill {
  name: string
  description: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
}

/** Parse `---` YAML frontmatter of a SKILL.md: requires `name`; `description` optional. */
function parseFrontmatter(content: string): ParsedSkill | null {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  let block = ''
  let i = 1
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') break
    block += `${lines[i]}\n`
  }
  if (i >= lines.length) return null
  let data: unknown
  try {
    data = yaml.load(block)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const map = data as Record<string, unknown>
  const str = (k: string): string => (typeof map[k] === 'string' ? (map[k] as string).trim() : '')
  const flag = (k: string): boolean | undefined =>
    typeof map[k] === 'boolean' ? map[k] : typeof map[k] === 'string' && /^(true|yes|1|on)$/i.test(map[k] as string) ? true : undefined
  const name = str('name')
  if (!name) return null
  const out: ParsedSkill = { name, description: str('description') }
  const dmi = flag('disable-model-invocation')
  const ui = flag('user-invocable')
  if (dmi !== undefined) out.disableModelInvocation = dmi
  if (ui !== undefined) out.userInvocable = ui
  return out
}

/** dsh's `isSkillName`: lowercase kebab — names not matching are ignored by dsh. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether a skill name is loadable by dsh (lowercase kebab, no `_`/uppercase/spaces). */
function validName(name: string): boolean {
  return SKILL_NAME_RE.test(name.trim())
}

/** Sanitize a name into a safe lowercase-kebab key for on-disk lookups. */
function sanitizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// --- git ---

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim() || t('git 执行失败', 'git failed')))
        else resolve(stdout.trim())
      })
  })
}

// --- discovery ---

function readOrigin(dir: string): SkillOrigin | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SKILL_META), 'utf8')) as Partial<SkillOrigin>
    if (typeof parsed.repo !== 'string' || typeof parsed.commit !== 'string') return undefined
    return { repo: parsed.repo, commit: parsed.commit, tag: typeof parsed.tag === 'string' ? parsed.tag : undefined }
  } catch {
    return undefined
  }
}

function skillFromDir(dir: string): SkillInfo | null {
  try {
    const parsed = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
    if (!parsed) return null
    return { name: parsed.name, description: parsed.description, kind: 'dir', origin: readOrigin(dir), disableModelInvocation: parsed.disableModelInvocation, userInvocable: parsed.userInvocable }
  } catch {
    return null
  }
}

/** List the home's `skills/` (enabled) and `.skill-off/` (disabled) contents. */
function listHome(home: string): { enabled: SkillInfo[]; disabled: SkillInfo[] } {
  const out: { enabled: SkillInfo[]; disabled: SkillInfo[] } = { enabled: [], disabled: [] }
  const scan = (dir: string, target: SkillInfo[]): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.system') continue
        const info = skillFromDir(p)
        if (info) target.push(info)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const parsed = parseFrontmatter(readFileSync(p, 'utf8'))
          if (parsed) target.push({ name: parsed.name, description: parsed.description, kind: 'file', disableModelInvocation: parsed.disableModelInvocation, userInvocable: parsed.userInvocable })
        } catch {
          /* ignore unreadable files */
        }
      }
    }
  }
  scan(enabledDir(home), out.enabled)
  scan(disabledDir(home), out.disabled)
  out.enabled.sort((a, b) => a.name.localeCompare(b.name))
  out.disabled.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** Locate a skill by display name (frontmatter) inside enabled/disabled shelves. */
function locate(home: string, name: string): { path: string; isDir: boolean; enabled: boolean } | null {
  const key = sanitizeName(name)
  const sides = [
    { dir: enabledDir(home), enabled: true },
    { dir: disabledDir(home), enabled: false }
  ]
  for (const side of sides) {
    const dirPath = join(side.dir, key)
    if (existsSync(dirPath) && existsSync(join(dirPath, 'SKILL.md'))) return { path: dirPath, isDir: true, enabled: side.enabled }
    const filePath = join(side.dir, `${key}.md`)
    if (existsSync(filePath)) return { path: filePath, isDir: false, enabled: side.enabled }
  }
  // Fallback: match by frontmatter name when the folder name differs from it.
  for (const side of sides) {
    if (!existsSync(side.dir)) continue
    for (const entry of readdirSync(side.dir, { withFileTypes: true })) {
      const p = join(side.dir, entry.name)
      let parsedName: string | undefined
      if (entry.isDirectory()) parsedName = skillFromDir(p)?.name
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          parsedName = parseFrontmatter(readFileSync(p, 'utf8'))?.name
        } catch {
          /* ignore */
        }
      }
      if (parsedName && (parsedName === name || sanitizeName(parsedName) === key)) {
        return { path: p, isDir: entry.isDirectory(), enabled: side.enabled }
      }
    }
  }
  return null
}

// --- install helpers ---

/** Parse a skill repo URL into (clone url, optional `#/sub/path`). */
export function parseSkillRepoUrl(url: string): { cloneUrl: string; sub: string | undefined } {
  const trimmed = url.trim()
  const hashAt = trimmed.indexOf('#')
  const base = hashAt >= 0 ? trimmed.slice(0, hashAt) : trimmed
  const sub = hashAt >= 0 ? trimmed.slice(hashAt + 1).replace(/^\/+/, '').trim() : ''
  if (!/^https?:\/\//.test(base)) throw new Error(t('SKILL 仓库地址需以 https:// 开头', 'SKILL repo URL must start with https://'))
  const pathPart = (base.split('://')[1] ?? '').split('@').pop() ?? ''
  if (pathPart.split('/').filter(Boolean).length < 3) {
    throw new Error(t('SKILL 仓库地址不完整(需要 host/owner/repo)', 'SKILL repo URL needs host/owner/repo'))
  }
  const cloneBase = base.replace(/\/+$/, '').replace(/\.git$/, '')
  return { cloneUrl: `${cloneBase}.git`, sub: sub || undefined }
}

/** Collect skill bundles under a clone: explicit sub path, root SKILL.md, or top-level dirs. */
function collectBundles(root: string, sub: string | undefined): string[] {
  if (sub) {
    const dir = join(root, sub)
    if (!existsSync(join(dir, 'SKILL.md'))) throw new Error(t(`子目录 ${sub} 中没有 SKILL.md`, `No SKILL.md under ${sub}`))
    return [dir]
  }
  if (existsSync(join(root, 'SKILL.md'))) return [root]
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
    .map(e => join(root, e.name))
  if (dirs.length === 0) throw new Error(t('仓库中没有找到 SKILL.md', 'No SKILL.md found in the repo'))
  return dirs
}

/** Copy a bundle into `<home>/skills/<name>`, removing any prior copy; records origin. */
function writeBundle(home: string, bundle: string, origin?: SkillOrigin): string {
  const parsed = parseFrontmatter(readFileSync(join(bundle, 'SKILL.md'), 'utf8'))
  if (!parsed) throw new Error(t('SKILL.md 缺少有效 frontmatter', 'SKILL.md lacks valid frontmatter'))
  if (!validName(parsed.name)) {
    throw new Error(t(`SKILL 名称「${parsed.name}」不符合 dsh 规范(小写字母/数字/连字符,如 my-skill)`, `SKILL name "${parsed.name}" must match dsh rules (lowercase kebab, e.g. my-skill)`))
  }
  const key = sanitizeName(parsed.name)
  const existing = locate(home, parsed.name)
  if (existing) rmSync(existing.path, { recursive: true, force: true })
  const dest = join(enabledDir(home), key)
  mkdirSync(enabledDir(home), { recursive: true })
  cpSync(bundle, dest, { recursive: true, filter: src => !src.split(/[\\/]/).includes('.git') })
  if (origin) writeFileSync(join(dest, SKILL_META), JSON.stringify(origin, null, 2), 'utf8')
  return parsed.name
}

// --- skill library (canonical store) ---

/** Scan the skill library root (directories carrying SKILL.md), sorted by name. */
function listLibraryDir(): SkillInfo[] {
  const root = skillLibraryRoot()
  if (!existsSync(root)) return []
  const out: SkillInfo[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.system') continue
    const info = skillFromDir(join(root, entry.name))
    if (info) out.push(info)
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** Locate a library entry by name → its directory, or null when absent. */
function locateLibrary(name: string): string | null {
  const key = sanitizeName(name)
  const root = skillLibraryRoot()
  const direct = join(root, key)
  if (existsSync(join(direct, 'SKILL.md'))) return direct
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const p = join(root, entry.name)
    const info = skillFromDir(p)
    if (info && (info.name === name || sanitizeName(info.name) === key)) return p
  }
  return null
}

/** Copy a whole skill folder into the library; a same-name entry is replaced first. */
function writeLibraryBundle(bundle: string, origin?: SkillOrigin): string {
  const parsed = parseFrontmatter(readFileSync(join(bundle, 'SKILL.md'), 'utf8'))
  if (!parsed) throw new Error(t('SKILL.md 缺少有效 frontmatter', 'SKILL.md lacks valid frontmatter'))
  if (!validName(parsed.name)) {
    throw new Error(t(`SKILL 名称「${parsed.name}」不符合 dsh 规范(小写字母/数字/连字符,如 my-skill)`, `SKILL name "${parsed.name}" must match dsh rules (lowercase kebab, e.g. my-skill)`))
  }
  const key = sanitizeName(parsed.name)
  const existing = locateLibrary(parsed.name)
  if (existing) rmSync(existing, { recursive: true, force: true })
  const dest = join(skillLibraryRoot(), key)
  mkdirSync(skillLibraryRoot(), { recursive: true })
  cpSync(bundle, dest, { recursive: true, filter: src => !src.split(/[\\/]/).includes('.git') })
  if (origin) writeFileSync(join(dest, SKILL_META), JSON.stringify(origin, null, 2), 'utf8')
  return parsed.name
}

/** Write a flat SKILL.md file into the library as `<key>/SKILL.md`. */
function writeLibraryFile(content: string): string {
  const parsed = parseFrontmatter(content)
  if (!parsed) throw new Error(t('SKILL.md 缺少有效 frontmatter(name/description)', 'SKILL.md lacks valid frontmatter (name/description)'))
  if (!validName(parsed.name)) {
    throw new Error(t(`SKILL 名称「${parsed.name}」不符合 dsh 规范(小写字母/数字/连字符,如 my-skill)`, `SKILL name "${parsed.name}" must match dsh rules (lowercase kebab, e.g. my-skill)`))
  }
  const key = sanitizeName(parsed.name)
  const existing = locateLibrary(parsed.name)
  if (existing) rmSync(existing, { recursive: true, force: true })
  const dest = join(skillLibraryRoot(), key)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'SKILL.md'), content, 'utf8')
  return parsed.name
}

/**
 * Re-push a library entry to every instance that already carries a copy,
 * preserving each copy's enabled/disabled shelf state. Called after any library
 * mutation that changes a record in place (repo re-install / import overwrite /
 * create overwrite / policy edit / update).
 */
function syncLibraryToInstances(name: string): void {
  const lib = locateLibrary(name)
  if (!lib) return
  const key = sanitizeName(name)
  for (const inst of getInstances()) {
    try {
      const home = instanceDshHome(inst)
      const found = locate(home, name)
      if (!found) continue
      rmSync(found.path, { recursive: true, force: true })
      const destDir = found.enabled ? enabledDir(home) : disabledDir(home)
      mkdirSync(destDir, { recursive: true })
      cpSync(lib, join(destDir, key), { recursive: true, filter: src => !src.split(/[\\/]/).includes('.git') })
    } catch {
      /* skip broken instances / missing homes */
    }
  }
}

// --- public operations ---

/** List the skill library (canonical store: every entry). */
export function listSkillLibrary(): SkillInfo[] {
  return listLibraryDir()
}

/** List one instance's home skills, split by enabled / disabled shelf (matrix cells). */
export function listSkills(instanceId: string): { enabled: SkillInfo[]; disabled: SkillInfo[] } {
  return listHome(homeOf(instanceId))
}

/** Enable/disable by moving the bundle between `skills/` and `.skill-off/`. */
export function setSkillEnabled(instanceId: string, name: string, enabled: boolean): void {
  const home = homeOf(instanceId)
  const found = locate(home, name)
  if (!found) throw new Error(t(`SKILL「${name}」不存在`, `SKILL "${name}" does not exist`))
  if (found.enabled === enabled) return
  const destDir = enabled ? enabledDir(home) : disabledDir(home)
  mkdirSync(destDir, { recursive: true })
  renameSync(found.path, join(destDir, found.path.split(/[\\/]/).pop()!))
}

/** Assign a library skill to an instance: copy it (enabled) into the home's `skills/`. */
export function enableSkillFromLibrary(instanceId: string, name: string): string {
  const lib = locateLibrary(name)
  if (!lib) throw new Error(t(`SKILL「${name}」不在技能库`, `SKILL "${name}" is not in the skill library`))
  const origin = readOrigin(lib)
  return writeBundle(homeOf(instanceId), lib, origin)
}

/** Install skill(s) from a source repository URL into the library. */
export async function installSkillRepo(url: string): Promise<string[]> {
  const { cloneUrl, sub } = parseSkillRepoUrl(url)
  const tmp = join(tmpdir(), `dsh-skill-${randomUUID()}`)
  try {
    await git(['clone', '--depth', '1', cloneUrl, tmp])
    const commit = await git(['rev-parse', 'HEAD'], tmp)
    const tag = await git(['describe', '--tags', '--exact-match'], tmp).catch(() => '')
    const origin: SkillOrigin = { repo: url.trim(), commit, tag: tag || undefined }
    const names = collectBundles(tmp, sub).map(bundle => writeLibraryBundle(bundle, origin))
    for (const name of names) syncLibraryToInstances(name)
    return names
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** A skill discovered in a source repo (for the install picker). */
export async function listRepoSkills(url: string): Promise<RepoSkillInfo[]> {
  const { cloneUrl, sub } = parseSkillRepoUrl(url)
  const tmp = join(tmpdir(), `dsh-skill-${randomUUID()}`)
  try {
    await git(['clone', '--depth', '1', cloneUrl, tmp])
    const out: RepoSkillInfo[] = []
    for (const bundle of collectBundles(tmp, sub)) {
      const parsed = parseFrontmatter(readFileSync(join(bundle, 'SKILL.md'), 'utf8'))
      if (!parsed) continue
      const rel = bundle === tmp ? undefined : bundle.slice(tmp.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      out.push({ name: parsed.name, description: parsed.description, subpath: rel || undefined })
    }
    return out
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Check repo-sourced library entries for updates (recorded commit vs remote HEAD). */
export async function checkSkillUpdates(): Promise<SkillUpdateInfo[]> {
  const root = skillLibraryRoot()
  if (!existsSync(root)) return []
  const headCache = new Map<string, Promise<string | undefined>>()
  const headOf = (cloneUrl: string): Promise<string | undefined> => {
    let p = headCache.get(cloneUrl)
    if (!p) {
      p = git(['ls-remote', cloneUrl, 'HEAD']).then(out => out.split(/\s+/)[0] || undefined).catch(() => undefined)
      headCache.set(cloneUrl, p)
    }
    return p
  }
  const updates: SkillUpdateInfo[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const origin = readOrigin(dir)
    const info = skillFromDir(dir)
    if (!origin || !info) continue
    const latest = await headOf(parseSkillRepoUrl(origin.repo).cloneUrl)
    if (latest && latest !== origin.commit) {
      updates.push({ name: info.name, current: origin.commit.slice(0, 7), latest: latest.slice(0, 7) })
    }
  }
  return updates
}

/** Re-pull a repo-sourced library entry from its recorded origin (update). */
export async function updateSkill(name: string): Promise<string> {
  const lib = locateLibrary(name)
  if (!lib) throw new Error(t(`SKILL「${name}」不存在`, `SKILL "${name}" does not exist`))
  const origin = readOrigin(lib)
  if (!origin) throw new Error(t(`SKILL「${name}」不是从仓库安装的,无法更新`, `SKILL "${name}" is not repo-sourced; cannot update`))
  await installSkillRepo(origin.repo)
  const again = locateLibrary(name)
  const newOrigin = again ? readOrigin(again) : undefined
  return newOrigin?.tag ?? (newOrigin?.commit ?? '').slice(0, 7)
}

/** Delete a library entry; every instance's copy of that skill is removed too. */
export function deleteSkillLibrary(name: string): void {
  const lib = locateLibrary(name)
  if (lib) rmSync(lib, { recursive: true, force: true })
  for (const inst of getInstances()) {
    try {
      const found = locate(instanceDshHome(inst), name)
      if (found) rmSync(found.path, { recursive: true, force: true })
    } catch {
      /* skip broken instances */
    }
  }
}

/** Open a file dialog and import the chosen SKILL.md file into the library. */
export async function importSkillFileDialog(): Promise<string> {
  const win = BrowserWindow.getFocusedWindow()
  const opts: OpenDialogOptions = {
    title: t('选择 SKILL.md', 'Choose a SKILL.md'),
    properties: ['openFile'],
    filters: [{ name: 'SKILL', extensions: ['md'] }]
  }
  const r = win && !win.isDestroyed()
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (r.canceled || r.filePaths.length === 0) return ''
  return importSkillPath(r.filePaths[0])
}

/**
 * Import a local skill by filesystem path (drag & drop / dialog result).
 *
 * - A **folder containing `SKILL.md`** → copied whole into the library
 *   (`.git` skipped), replacing any existing skill of the same name.
 * - A **`.md` file** → written as a `<key>/SKILL.md` bundle.
 * - Anything else → clear error telling the caller what to drop.
 */
export function importSkillPath(path: string): string {
  const p = String(path).trim()
  if (!p) throw new Error(t('拖入路径为空', 'Drop path is empty'))
  let st
  try {
    st = statSync(p)
  } catch {
    throw new Error(t(`无法读取路径:${p}`, `Cannot read path: ${p}`))
  }
  let name: string
  if (st.isDirectory()) {
    if (!existsSync(join(p, 'SKILL.md'))) {
      throw new Error(t('文件夹里没有 SKILL.md,请拖入含 SKILL.md 的技能文件夹', 'The folder has no SKILL.md — drop a folder that contains SKILL.md'))
    }
    name = writeLibraryBundle(p)
  } else if (st.isFile() && p.toLowerCase().endsWith('.md')) {
    name = writeLibraryFile(readFileSync(p, 'utf8'))
  } else {
    throw new Error(t('请拖入 SKILL.md 文件或包含 SKILL.md 的文件夹', 'Drop a SKILL.md file or a folder containing SKILL.md'))
  }
  syncLibraryToInstances(name)
  return name
}

/** Create a library skill from pasted content; prepends a minimal frontmatter when missing. */
export function createSkill(name: string, description: string, content: string): string {
  const clean = name.trim()
  if (!validName(clean)) {
    throw new Error(t('SKILL 名称需为小写字母/数字/连字符(如 my-skill)', 'SKILL name must be lowercase kebab (e.g. my-skill)'))
  }
  const body = parseFrontmatter(content)
    ? content
    : `---\nname: ${clean}\ndescription: ${description.trim() || clean}\n---\n\n${content}`
  const created = writeLibraryFile(body)
  syncLibraryToInstances(created)
  return created
}

/** Rewrite one invocation-policy frontmatter key of a library entry, then re-sync assigned copies. */
export function setSkillLibraryPolicy(name: string, patch: SkillPolicyPatch): void {
  const lib = locateLibrary(name)
  if (!lib) throw new Error(t(`SKILL「${name}」不在技能库`, `SKILL "${name}" is not in the skill library`))
  const file = join(lib, 'SKILL.md')
  let content = readFileSync(file, 'utf8')
  if (!parseFrontmatter(content)) {
    throw new Error(t('技能缺少有效 frontmatter,无法改调用策略', 'Skill lacks frontmatter; cannot change invocation policy'))
  }
  if ('disableModelInvocation' in patch) content = setFrontmatterBool(content, 'disable-model-invocation', patch.disableModelInvocation ?? null)
  if ('userInvocable' in patch) content = setFrontmatterBool(content, 'user-invocable', patch.userInvocable ?? null)
  writeFileSync(file, content, 'utf8')
  syncLibraryToInstances(name)
}

// --- GitHub skill market (discover / install, mirroring market.ts patterns) ---

const GH_API = 'https://api.github.com'
const GH_UA = 'dsh-launcher/1.0.0 (https://github.com/MarcoG-h/DSH-Launcher)'
/** Topics a skill repo may be tagged with; searched in parallel and merged. */
const SKILL_TOPICS = ['dsh-skill', 'agent-skills', 'claude-skills']

function ghAuth(): Record<string, string> {
  const token = getConfig().githubToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function ghGet(path: string): Promise<{ status: number; body: unknown }> {
  const res = await net.fetch(`${GH_API}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': GH_UA, ...ghAuth() }
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** Search the skill market: per-topic GitHub searches merged by full name.
 *  `onlyTopic`(可选)限定单个 topic(GitHub AND 语义,供分类 chips 用)。 */
export async function searchSkillMarket(query?: string, onlyTopic?: string): Promise<SkillMarketRepo[]> {
  const kw = String(query ?? '').trim()
  const topics = onlyTopic && SKILL_TOPICS.includes(onlyTopic) ? [onlyTopic] : SKILL_TOPICS
  const perTopic = await Promise.all(topics.map(async (topic) => {
    const q = `topic:${topic}${kw ? ` ${kw}` : ''}`
    const r = await ghGet(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`)
    if (r.status !== 200 || typeof r.body !== 'object' || r.body === null) return []
    const items = (r.body as { items?: unknown[] }).items ?? []
    return items.map((it) => {
      const item = it as { full_name?: string; owner?: { login?: string }; name?: string; description?: string | null; stargazers_count?: number; default_branch?: string }
      const fullName = item.full_name ?? ''
      const slash = fullName.indexOf('/')
      return {
        owner: slash >= 0 ? fullName.slice(0, slash) : String(item.owner?.login ?? ''),
        repo: slash >= 0 ? fullName.slice(slash + 1) : String(item.name ?? ''),
        fullName,
        description: item.description ?? '',
        stars: Number(item.stargazers_count ?? 0),
        defaultBranch: String(item.default_branch ?? 'main')
      }
    }).filter(x => x.fullName)
  }))
  const byName = new Map<string, SkillMarketRepo>()
  for (const list of perTopic) for (const repo of list) byName.set(repo.fullName, repo)
  return [...byName.values()].sort((a, b) => b.stars - a.stars).slice(0, 30)
}

/** List SKILL.md bundles a repo offers (git trees, recursive; previews fetched when few). */
export async function listSkillRepoSkills(owner: string, repo: string): Promise<SkillRepoCandidate[]> {
  const enc = (s: string): string => encodeURIComponent(s)
  const meta = await ghGet(`/repos/${enc(owner)}/${enc(repo)}`)
  const branch = (meta.body as { default_branch?: string } | null)?.default_branch ?? 'main'
  const tree = await ghGet(`/repos/${enc(owner)}/${enc(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
  const body = tree.body as { tree?: { path?: string; type?: string }[] } | null
  if (tree.status !== 200 || !Array.isArray(body?.tree)) {
    throw new Error(t(`无法读取仓库 ${owner}/${repo} 的目录树`, `Cannot read repo ${owner}/${repo} tree`))
  }
  const seen = new Set<string>()
  const paths: string[] = []
  for (const entry of body.tree ?? []) {
    if (entry.type !== 'blob' || !entry.path?.endsWith('SKILL.md')) continue
    const dir = entry.path.slice(0, entry.path.length - 'SKILL.md'.length).replace(/\/+$/, '')
    const depth = dir.split('/').filter(Boolean).length
    if (!dir || depth > 4 || seen.has(dir)) continue
    seen.add(dir)
    paths.push(dir)
  }
  paths.sort()
  const withPreview = paths.length <= 20
  const out: SkillRepoCandidate[] = await Promise.all(paths.map(async (dir) => {
    const candidate: SkillRepoCandidate = { path: dir }
    if (withPreview) {
      try {
        const raw = await net.fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dir}/SKILL.md`, {
          headers: { 'User-Agent': GH_UA, ...ghAuth() }
        })
        const text = await raw.text()
        const parsed = parseFrontmatter(text)
        if (parsed) {
          candidate.name = parsed.name
          candidate.description = parsed.description
        }
      } catch {
        /* preview is best-effort */
      }
    }
    return candidate
  }))
  return out
}

// --- soft enable/disable via frontmatter (line-level edit) ---

/** Rewrite one boolean frontmatter key; value `null` removes the line. */
function setFrontmatterBool(content: string, key: string, value: boolean | null): string {
  const lines = content.split('\n')
  const open = lines.findIndex(l => l.trim() === '---')
  if (open < 0) return content
  let close = -1
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break }
  }
  if (close < 0) return content
  const inside = (i: number): boolean => i > open && i < close
  const re = new RegExp(`^\\s*${key}\\s*:`)
  const hit = lines.findIndex((l, i) => inside(i) && re.test(l))
  if (hit >= 0) {
    if (value === null) lines.splice(hit, 1)
    else lines[hit] = lines[hit].replace(re, `${key}: ${value}`)
    return lines.join('\n')
  }
  if (value !== null) lines.splice(open + 1, 0, `${key}: ${value}`)
  return lines.join('\n')
}

/** Soft toggle: edit `disable-model-invocation` / `user-invocable` frontmatter. */
export function setSkillPolicy(instanceId: string, name: string, patch: SkillPolicyPatch): void {
  const found = locate(homeOf(instanceId), name)
  if (!found) throw new Error(t(`SKILL「${name}」不存在`, `SKILL "${name}" does not exist`))
  const file = found.isDir ? join(found.path, 'SKILL.md') : found.path
  let content = readFileSync(file, 'utf8')
  if (!parseFrontmatter(content)) {
    throw new Error(t('技能缺少有效 frontmatter,无法改调用策略', 'Skill lacks frontmatter; cannot change invocation policy'))
  }
  if ('disableModelInvocation' in patch) content = setFrontmatterBool(content, 'disable-model-invocation', patch.disableModelInvocation ?? null)
  if ('userInvocable' in patch) content = setFrontmatterBool(content, 'user-invocable', patch.userInvocable ?? null)
  writeFileSync(file, content, 'utf8')
}
