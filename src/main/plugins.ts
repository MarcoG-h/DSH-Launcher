import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import * as yaml from 'js-yaml'
import { net } from 'electron'
import { getConfig, setConfig } from './config'
import { addInstance, getActiveInstance, instanceDshHome } from './instances'
import { t } from './i18n'
import { bundledEnv, downloadFile, extractZip, progressLine, resolveBundledNode } from './runtime'
import { runAsync, taskDone, taskLine, taskProgress } from './task'
import { bundleTaskLabel, RECOMMENDED_BUNDLES } from '../shared/bundles'
import { parseGitHubUrl } from '../shared/github'
import type { CmdResult, InstalledPlugin, LocalPlugin, PluginCellStatus, PluginListResult, PluginMatrixColumn, PluginMatrixResult, PluginMeta } from '../shared/types'

function readJson(file: string): Record<string, unknown> | null {
  try {
    // 剥 UTF-8 BOM:Windows 记事本等外部工具可能写入 BOM,JSON.parse 不认。
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

/** `<home>/profiles/<name>` — 每个 DSH_HOME 有自己独立的 profiles 树。 */
function profileDir(home: string, profile: string): string {
  return join(home, 'profiles', profile)
}

// --- profile patch layer (cordis.patch.yml) ---
//
// A profile mounts its plugins through TWO channels (the harness's contract):
// `dsh.profile.bundles` for packages that declare `dsh.bundle.patch` (their own
// patch mounts them), and `insert` entries in the profile's `cordis.patch.yml`
// for everything else — a client-only plugin CANNOT be a bundle layer, and boot
// fails loud if one is listed there. The insert channel is what client-only
// plugins (installed via `dsh plugin add`) use.

/**
 * The entry-list YAML dialect of the profile patch layer: `!!js` scalars are
 * expression nodes the Loader evaluates at activation. js-yaml only applies one
 * schema per parse, so registering the same custom type the harness's
 * cordis-plugin-include uses lets a round-trip through `cordis.patch.yml`
 * preserve a user's `!!js` expressions instead of mangling them into strings.
 */
const isJsExpr = (data: unknown): data is { __jsExpr: string } =>
  typeof data === 'object' && data !== null && '__jsExpr' in data

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data: object) => (data as { __jsExpr: string }).__jsExpr,
})

const ENTRY_LIST_SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr)

/** Read a profile's user patch layer as a parsed patch-array; a missing/broken file is `[]`. */
function readProfilePatches(home: string, profile: string): unknown[] {
  const file = join(profileDir(home, profile), 'cordis.patch.yml')
  try {
    const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: ENTRY_LIST_SCHEMA })
    return Array.isArray(parsed) ? (parsed as unknown[]) : []
  } catch {
    return []
  }
}

/** Write a profile's user patch layer, keeping the stock header comment. */
function writeProfilePatches(home: string, profile: string, patches: unknown[]): void {
  const file = join(profileDir(home, profile), 'cordis.patch.yml')
  const header = '# Your patch layer for this dsh profile, applied after every bundle layer:\n'
    + '# a top-level YAML array of loader patch entries (id-targeted config\n'
    + '# overrides, disables, and insert lists; `!!js` expressions allowed).\n'
  writeFileSync(file, header + yaml.dump(patches, { schema: ENTRY_LIST_SCHEMA, noRefs: true }) + '\n')
}

/** The launcher-managed patch insert id for a plugin (stable, sanitized package name). */
function pluginInsertId(name: string): string {
  return name.replace(/^@/, '').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-')
}

/** Names and launcher ids of every `insert` entry in the profile patch layer. */
function patchInsertedPlugins(home: string, profile: string): { names: Set<string>; ids: Set<string> } {
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const patch of readProfilePatches(home, profile)) {
    if (typeof patch !== 'object' || patch === null) continue
    const insert = (patch as Record<string, unknown>).insert
    if (!Array.isArray(insert)) continue
    for (const entry of insert) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      if (typeof e.name === 'string') names.add(e.name)
      if (typeof e.id === 'string') ids.add(e.id)
    }
  }
  return { names, ids }
}

/** Whether a plugin is currently mounted through the profile patch layer. */
function patchEnabled(home: string, profile: string, name: string): boolean {
  const { names, ids } = patchInsertedPlugins(home, profile)
  return names.has(name) || ids.has(pluginInsertId(name))
}

/** Add a plugin's insert to the profile patch layer (idempotent by name or id). */
function addPluginInsert(home: string, profile: string, name: string): boolean {
  const { names, ids } = patchInsertedPlugins(home, profile)
  if (names.has(name) || ids.has(pluginInsertId(name))) return false
  const patches = readProfilePatches(home, profile)
  patches.push({ insert: [{ id: pluginInsertId(name), name }] })
  writeProfilePatches(home, profile, patches)
  return true
}

/** Remove a plugin's insert from the profile patch layer; targeted patches are untouched. */
function removePluginInsert(home: string, profile: string, name: string): boolean {
  const id = pluginInsertId(name)
  const patches = readProfilePatches(home, profile)
  const next: unknown[] = []
  let changed = false
  for (const patch of patches) {
    if (typeof patch !== 'object' || patch === null) { next.push(patch); continue }
    const record = patch as Record<string, unknown>
    const insert = record.insert
    if (!Array.isArray(insert)) { next.push(patch); continue }
    const kept = insert.filter((entry) => {
      if (typeof entry !== 'object' || entry === null) return true
      const e = entry as Record<string, unknown>
      return e.name !== name && e.id !== id
    })
    if (kept.length === insert.length) { next.push(patch); continue }
    changed = true
    if (kept.length > 0) next.push({ ...record, insert: kept })
  }
  if (!changed) return false
  writeProfilePatches(home, profile, next)
  return true
}

/** Resolve a profile-installed plugin's package.json (link target first, then node_modules). */
function pluginManifest(home: string, profile: string, name: string): Record<string, unknown> | null {
  const dir = profileDir(home, profile)
  const manifest = readJson(join(dir, 'package.json'))
  const deps = (manifest?.dependencies as Record<string, string> | undefined) ?? {}
  const spec = String(deps[name] ?? '')
  const local = spec.match(/^(?:file|link):(.+)$/)
  if (local) {
    const pkg = readJson(join(resolve(dir, local[1]), 'package.json'))
    if (pkg) return pkg
  }
  return readJson(join(dir, 'node_modules', name, 'package.json'))
}

/** Whether an installed plugin declares a profile bundle layer (`dsh.bundle.patch`). */
function pluginIsBundle(home: string, profile: string, name: string): boolean {
  const pkg = pluginManifest(home, profile, name)
  return Boolean((pkg?.dsh as Record<string, unknown> | undefined)?.bundle)
}

/** The profile's current `dsh.profile.bundles` list. */
function bundlesOf(home: string, profile: string): string[] {
  const manifest = readJson(join(profileDir(home, profile), 'package.json'))
  const profileBlock = (manifest?.dsh as Record<string, unknown> | undefined)?.profile as Record<string, unknown> | undefined
  return Array.isArray(profileBlock?.bundles) ? (profileBlock.bundles as string[]) : []
}

function pnpmCmd(args: string[], cwd: string, label: string): Promise<CmdResult> {
  const cfg = getConfig()
  return runAsync(cfg.pnpm, args, cwd, label, process.platform === 'win32')
}

function dshPluginCmd(home: string, profile: string, extra: string[]): { cmd: string; args: string[]; cwd: string; envPatch?: NodeJS.ProcessEnv } {
  const cfg = getConfig()
  if (cfg.installMode === 'bundled') {
    // Run the bundled CLI; PATH is prefixed so its internal pnpm resolves to the portable copy.
    return {
      cmd: resolveBundledNode() ?? cfg.nodePath,
      args: [...cfg.launchArgs, 'plugin', '--profile', profile, ...extra],
      cwd: cfg.runtimeRoot,
      envPatch: { ...bundledEnv(), DSH_HOME: home }
    }
  }
  return {
    cmd: cfg.nodePath,
    args: [...cfg.launchArgs, 'plugin', '--profile', profile, ...extra],
    cwd: cfg.harnessRepo,
    envPatch: { DSH_HOME: home }
  }
}

// --- reads ---

export function listInstalled(home: string, profile: string): { installed: InstalledPlugin[]; bundles: string[] } {
  const dir = profileDir(home, profile)
  const manifest = readJson(join(dir, 'package.json'))
  const deps = (manifest?.dependencies as Record<string, string> | undefined) ?? {}
  const dsh = manifest?.dsh as Record<string, unknown> | undefined
  const profileBlock = dsh?.profile as Record<string, unknown> | undefined
  const bundles: string[] = Array.isArray(profileBlock?.bundles) ? (profileBlock.bundles as string[]) : []

  const patchInserts = patchInsertedPlugins(home, profile)
  const installed: InstalledPlugin[] = []
  for (const [name, specRaw] of Object.entries(deps)) {
    const spec = String(specRaw)
    const pkgPath = join(dir, 'node_modules', name, 'package.json')
    let version = ''
    let description = ''
    let isBundle = false
    let localPath: string | null = null
    try {
      const pkg = readJson(realpathSync(pkgPath)) ?? {}
      version = String(pkg.version ?? '')
      description = String(pkg.description ?? '')
      isBundle = Boolean((pkg.dsh as Record<string, unknown> | undefined)?.bundle)
    } catch {
      /* uninstalled / broken — show with empty metadata */
    }
    const localSpec = spec.match(/^(?:file|link):(.+)$/)
    if (localSpec) {
      const p = localSpec[1]
      try {
        localPath = realpathSync(resolve(dir, p))
      } catch {
        localPath = resolve(dir, p)
      }
    }
    installed.push({
      name,
      version,
      description,
      spec,
      localPath,
      enabled: bundles.includes(name) || patchInserts.names.has(name) || patchInserts.ids.has(pluginInsertId(name)),
      isBundle,
      inBox: false
    })
  }
  return { installed, bundles }
}

/** Build a LocalPlugin entry from a package.json + its on-disk directory. */
function localEntry(pkg: Record<string, unknown>, path: string): Omit<LocalPlugin, 'status'> {
  return {
    name: String(pkg.name),
    version: String(pkg.version ?? ''),
    description: String(pkg.description ?? ''),
    path,
    isBundle: Boolean((pkg.dsh as Record<string, unknown> | undefined)?.bundle),
    platform: String(((pkg.dsh as Record<string, unknown> | undefined)?.client as Record<string, unknown> | undefined)?.platform ?? '') || null
  }
}

/**
 * Scan pluginDir for plugin packages, without any profile-status info.
 * A repo that is itself a dsh plugin is listed as-is; a collection / skin-pack
 * repo (no root manifest — e.g. dsh-deep-whale ships its package under
 * `maid-atelier/`) contributes one entry per plugin subpackage. Mirrors the
 * resolution downloadPlugin performs, so everything downloaded shows up here.
 */
function scanLocal(): Array<Omit<LocalPlugin, 'status'>> {
  const cfg = getConfig()
  const out: Array<Omit<LocalPlugin, 'status'>> = []
  if (!existsSync(cfg.pluginDir)) return out
  for (const entry of readdirSync(cfg.pluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules') continue // 运行时链接层(junction),不是插件仓库
    const entryPath = join(cfg.pluginDir, entry.name)
    if (looksLikeDshPlugin(entryPath).ok) {
      const pkg = readJson(join(entryPath, 'package.json')) ?? {}
      out.push(localEntry(pkg, entryPath))
      continue
    }
    // Not a standalone plugin at the root — pick up any plugin subpackages.
    for (const sub of findPluginSubpackages(entryPath)) {
      const pkg = readJson(join(entryPath, sub.path, 'package.json')) ?? {}
      out.push(localEntry(pkg, join(entryPath, sub.path)))
    }
  }
  return out
}

export function listLocal(home: string, profile: string): LocalPlugin[] {
  const { installed } = listInstalled(home, profile)
  const enabled = new Set(installed.filter((p) => p.enabled).map((p) => p.name))
  return scanLocal().map((p) => ({ ...p, status: enabled.has(p.name) ? 'enabled' : 'not-installed' }))
}

export function listPlugins(): PluginListResult {
  const inst = getActiveInstance()
  const home = instanceDshHome(inst)
  const { installed, bundles } = listInstalled(home, inst.profile)
  return { profile: inst.profile, bundles, installed, local: listLocal(home, inst.profile) }
}

// --- plugin × instance matrix ---

/**
 * The local-plugins matrix: rows are the pluginDir plugins, columns are the
 * configured instances, cells carry that instance's status for the plugin
 * (enabled / installed / not-installed). Rows also carry the user's
 * display-name override + remark from config.pluginMeta.
 */
export function listPluginMatrix(): PluginMatrixResult {
  const cfg = getConfig()
  // Hidden instances stay out of the matrix — manage them from the Instances page.
  const shown = cfg.instances.filter(i => i.enabled !== false)
  const columns: PluginMatrixColumn[] = shown.map((inst) => ({
    id: inst.id,
    name: inst.name,
    profile: inst.profile,
    running: false
  }))
  const meta = cfg.pluginMeta ?? {}
  const localRows: PluginMatrixResult['rows'] = scanLocal().map((p) => ({
    name: p.name,
    displayName: meta[p.name]?.displayName?.trim() || p.name,
    version: p.version,
    description: p.description,
    remark: meta[p.name]?.remark ?? '',
    path: p.path,
    isBundle: p.isBundle,
    platform: p.platform,
    spec: ''
  }))
  const localNames = new Set(localRows.map((r) => r.name))

  const cells: Record<string, Record<string, PluginCellStatus>> = {}
  // 直装插件行:未在本地库、但被某实例 `dsh plugin add`(github:/npm)直装且已启用的包。
  // 只收 enabled —— ensureRuntimeLinks 会把 schemastery / cosmokit 等非 cordis 运行时
  // 依赖也直装进 profile(但 enabled=false),并全量 installed 会把它们变成假插件行,
  // 用户一「启用」就会让 boot 报 invalid plugin。localPath 非空的 file:/link: 依赖
  // 要么落在本地库(已被 localNames 覆盖)、要么是罕见的外部目录依赖,都不进直装行。
  const directRows: PluginMatrixResult['rows'] = []
  const seen = new Set<string>()
  for (const inst of shown) {
    const { installed } = listInstalled(instanceDshHome(inst), inst.profile)
    for (const p of installed) {
      if (p.enabled) (cells[p.name] ??= {})[inst.id] = 'enabled'
      if (!p.enabled || p.localPath !== null || localNames.has(p.name) || seen.has(p.name)) continue
      seen.add(p.name)
      directRows.push({
        name: p.name,
        displayName: meta[p.name]?.displayName?.trim() || p.name,
        version: p.version,
        description: p.description,
        remark: meta[p.name]?.remark ?? '',
        path: '',
        isBundle: p.isBundle,
        platform: null,
        spec: p.spec
      })
    }
  }
  return { rows: [...localRows, ...directRows], columns, cells }
}

/** Persist a plugin's display-name override / remark (global, not per instance). */
export function setPluginMeta(name: string, meta: PluginMeta): void {
  const cfg = getConfig()
  const all = { ...(cfg.pluginMeta ?? {}) }
  const next: PluginMeta = { ...(all[name] ?? {}), ...meta }
  if (!next.displayName?.trim() && !next.remark?.trim()) {
    delete all[name]
  } else {
    all[name] = next
  }
  setConfig({ pluginMeta: all })
}

// --- mutations ---

/**
 * pnpm ≥10 reads workspace settings from `pnpm-workspace.yaml`, not `.npmrc`.
 * Ensure a profile's workspace file (a) fixes the literal `set this to true or
 * false` placeholders dsh/pnpm leave when builds are never approved, and
 * (b) restricts `supportedArchitectures` to the current platform — otherwise
 * pnpm tries to fetch every cross-platform optionalDependency (e.g.
 * node-llama-cpp's `@node-llama-cpp/linux-x64-cuda`, which usually fails on the
 * China mirror and takes the whole profile install down with it). Best-effort:
 * never throws; only touches the known placeholder text or the missing block.
 */
function ensureProfilePnpmSettings(home: string, profile: string): void {
  const path = join(profileDir(home, profile), 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  try {
    let text = readFileSync(path, 'utf8')
    let changed = false
    if (text.includes('set this to true or false')) {
      text = text.split('set this to true or false').join('true')
      changed = true
    }
    if (!text.includes('supportedArchitectures')) {
      text += `\nsupportedArchitectures:\n  os:\n    - ${process.platform}\n  cpu:\n    - ${process.arch}\n`
      changed = true
    }
    if (changed) writeFileSync(path, text)
  } catch {
    /* best-effort — a malformed workspace file must not block installs */
  }
}

/** Package names currently listed in a profile's `dependencies`. */
function depNames(home: string, profile: string): Set<string> {
  const manifest = readJson(join(profileDir(home, profile), 'package.json'))
  const deps = (manifest?.dependencies as Record<string, string> | undefined) ?? {}
  return new Set(Object.keys(deps))
}

/**
 * pnpm 10 requires build-running packages to be listed under `allowBuilds:` in
 * the profile's pnpm-workspace.yaml. Git-hosted plugins that run build scripts
 * (e.g. a prepack/prepare that compiles the client) hit
 * `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` otherwise.
 *
 * IMPORTANT — key form: pnpm matches allowBuilds keys against the dependency's
 * full path. For git-hosted installs the version is a non-semver (codeload
 * patch hash), so plain `name:` and `name@version:` keys are NOT trusted
 * (`trustPackageIdentity` is false). The only stable key is the repo-level
 * `name@git+https://github.com/owner/repo.git` form (pnpm normalizes
 * codeload/github URLs to this via `gitHostedTarballRepoKey`). It does not
 * change between installs, unlike the hash-embedded depPath.
 */
function allowBuildsWhitelist(home: string, profile: string, gitRepoKey: string): boolean {
  const path = join(profileDir(home, profile), 'pnpm-workspace.yaml')
  if (!existsSync(path)) return false
  try {
    let text = readFileSync(path, 'utf8')
    if (text.includes(`  ${gitRepoKey}: true`)) return false
    // Line-based so \r\n (Windows) and \n both work — a regex relying on \n[a-z]
    // silently fails to bound the block under CRLF.
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/)
    const idx = lines.findIndex((l) => /^allowBuilds\s*:/.test(l))
    if (idx >= 0) {
      // Block ends at the first following line that isn't indented (or EOF).
      let end = idx + 1
      while (end < lines.length && /^[ \t]/.test(lines[end])) end += 1
      lines.splice(end, 0, `  ${gitRepoKey}: true`)
    } else {
      lines.push('', 'allowBuilds:', `  ${gitRepoKey}: true`)
    }
    writeFileSync(path, lines.join(eol))
    return true
  } catch {
    /* best-effort — a malformed workspace file must not block installs */
    return false
  }
}

/**
 * Pull the repo-level allowBuilds key out of pnpm's git-prepare error. pnpm's
 * hint block shows the key to add, e.g.:
 *   allowBuilds:
 *     dsh-web-plugin-manager@git+https://github.com/LX2000WASD/dsh-web-plugin-manager.git: true
 * We parse the stable repo key (name@git+https://...git) from the hint, falling
 * back to deriving it from the fetched-from codeload URL in the error text.
 */
function parseAllowBuildsKey(stderr: string | undefined): string | null {
  if (!stderr) return null
  // Prefer pnpm's own suggested key line under "For example:\nallowBuilds:".
  const hint = /allowBuilds:\s*\n\s*([^\s:]+@git\+[^:]+\.git):\s*true/.exec(stderr)
  if (hint && hint[1]) return hint[1]
  // Fallback: derive name@git+https://github.com/owner/repo.git from a codeload URL.
  const name = /The git-hosted package "([^"@]+)/.exec(stderr)?.[1]
  const codeload = /https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\//.exec(stderr)
  if (name && codeload && codeload[1] && codeload[2]) {
    return `${name}@git+https://github.com/${codeload[1]}/${codeload[2]}.git`
  }
  return null
}

/**
 * Install a plugin (local path or npm spec) into a profile via `dsh plugin add`
 * and enable it for that profile. With a known `name` we enable explicitly
 * (also self-heals legacy "installed but not enabled" entries); otherwise the
 * newly-added dependency is detected by diffing the manifest and enabled.
 */
export async function install(home: string, profile: string, spec: string, name?: string, flags?: string[]): Promise<CmdResult> {
  if (!spec.trim()) return { ok: false, code: null, error: t('安装源为空。', 'Empty install source.') }
  const target = /^\.{1,2}[/\\]/.test(spec) ? resolve(process.cwd(), spec) : spec
  // 自愈该 profile 的 pnpm 工作区设置(allowBuilds 占位符 / supportedArchitectures),
  // 否则 node-llama-cpp 等原生依赖的跨平台二进制会让整个 profile 的安装失败。
  ensureProfilePnpmSettings(home, profile)
  const before = depNames(home, profile)
  const { cmd, args, cwd, envPatch } = dshPluginCmd(home, profile, ['add', target, ...(flags ?? [])])
  let r = await runAsync(cmd, args, cwd, `install:${target}`, process.platform === 'win32', envPatch)
  if (!r.ok) {
    // pnpm 10 blocks git-hosted packages that run build scripts unless they're
    // in the profile's allowBuilds whitelist. Self-heal: whitelist the package
    // and retry once. Without this, such plugins permanently fail to install.
    const blocked = parseAllowBuildsKey(r.stderr)
    if (blocked && allowBuildsWhitelist(home, profile, blocked)) {
      taskLine(`install:${target}`, t(`检测到 pnpm allowBuilds 白名单缺失,已加入 ${blocked} 并重试…`, `Detected missing allowBuilds whitelist entry; added ${blocked} and retrying…`), 'stderr')
      r = await runAsync(cmd, args, cwd, `install:${target}`, process.platform === 'win32', envPatch)
    }
  }
  if (r.ok) {
    if (name) {
      setEnabled(home, profile, name, true)
    } else {
      const after = depNames(home, profile)
      for (const n of after) if (!before.has(n)) setEnabled(home, profile, n, true)
    }
  }
  return r
}

export async function remove(home: string, profile: string, name: string): Promise<CmdResult> {
  const { cmd, args, cwd, envPatch } = dshPluginCmd(home, profile, ['remove', name])
  return runAsync(cmd, args, cwd, `remove:${name}`, process.platform === 'win32', envPatch)
}

/** Uninstall a plugin from a profile: drop it from bundles first, then the dependency. */
export async function disable(home: string, profile: string, name: string): Promise<CmdResult> {
  setEnabled(home, profile, name, false)
  return remove(home, profile, name)
}

/**
 * Update / reinstall a plugin. Plugins installed via downloadPlugin live in a
 * git clone under pluginDir (a `file:` dependency) — updating them means
 * git pull + reinstall. Any other spec (github:/npm) updates via `dsh plugin up`.
 */
export async function update(home: string, profile: string, name: string): Promise<CmdResult> {
  const dir = profileDir(home, profile)
  const manifest = readJson(join(dir, 'package.json'))
  const spec = String((manifest?.dependencies as Record<string, string> | undefined)?.[name] ?? '')
  const label = `update:${name}`

  const local = spec.match(/^(?:file|link):(.+)$/)
  if (local) {
    const p = local[1]
    let localPath: string
    try {
      localPath = realpathSync(resolve(dir, p))
    } catch {
      localPath = resolve(dir, p)
    }
    if (existsSync(join(localPath, '.git'))) {
      const git = await ensureGit(label)
      if (!git.ok) {
        taskLine(label, git.error, 'stderr')
      } else {
        const pull = await runAsync(git.exe, ['-C', localPath, 'pull', '--ff-only'], process.cwd(), label, process.platform === 'win32', gitEnvFor(git.exe), GIT_TIMEOUT_MS)
        if (!pull.ok) taskLine(label, t('[update] 拉取失败，继续重装现有代码。', '[update] Pull failed; reinstalling existing code.'), 'stderr')
      }
    }
    return install(home, profile, localPath)
  }

  const { cmd, args, cwd, envPatch } = dshPluginCmd(home, profile, ['up', name])
  return runAsync(cmd, args, cwd, label, process.platform === 'win32', envPatch)
}

/**
 * Toggle a plugin's activation in a profile WITHOUT touching the installed
 * dependency. Two channels, matching the harness's profile contract: a package
 * that declares `dsh.bundle.patch` is a bundle layer and belongs in
 * `dsh.profile.bundles` (its own patch mounts it); a plain plugin — no bundle
 * declaration, typically a client-only package — cannot be a layer (boot fails
 * loud on it) and is instead mounted through an `insert` in the profile's user
 * patch layer (`cordis.patch.yml`, which the harness hot-reloads).
 */
export function setEnabled(home: string, profile: string, name: string, enabled: boolean): { ok: boolean; changed: boolean; bundles: string[] } {
  if (!pluginIsBundle(home, profile, name)) {
    const changed = enabled ? addPluginInsert(home, profile, name) : removePluginInsert(home, profile, name)
    return { ok: true, changed, bundles: bundlesOf(home, profile) }
  }
  const dir = profileDir(home, profile)
  const mp = join(dir, 'package.json')
  const manifest = readJson(mp) ?? {}
  const dsh = (manifest.dsh as Record<string, unknown> | undefined) ?? {}
  const profileBlock = (dsh.profile as Record<string, unknown> | undefined) ?? {}
  const bundles = new Set((profileBlock.bundles as string[] | undefined) ?? [])

  let changed = false
  if (enabled && !bundles.has(name)) {
    bundles.add(name)
    changed = true
  } else if (!enabled && bundles.has(name)) {
    bundles.delete(name)
    changed = true
  }
  const list = [...bundles]
  if (changed) {
    const next = { ...manifest, dsh: { ...dsh, profile: { ...profileBlock, bundles: list } } }
    writeFileSync(mp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  }
  return { ok: true, changed, bundles: list }
}

/**
 * Repair a profile's plugin activation: strip every non-bundle name from
 * `dsh.profile.bundles` (a client-only plugin there fails boot loud), mounting
 * it through the patch layer instead, and ensure every bundle-declaring
 * dependency is present in the layer list. This is the sanitizer the harness's
 * own `reconcilePlugins` performs on the next `dsh plugin` command, run eagerly
 * so a profile poisoned by an older launcher heals on reuse.
 */
export function repairProfile(home: string, profile: string): { ok: boolean; changed: boolean; bundles: string[] } {
  const dir = profileDir(home, profile)
  const mp = join(dir, 'package.json')
  const manifest = readJson(mp)
  if (!manifest) return { ok: true, changed: false, bundles: [] }
  const deps = (manifest.dependencies as Record<string, string> | undefined) ?? {}
  const dsh = manifest.dsh as Record<string, unknown> | undefined
  const profileBlock = dsh?.profile as Record<string, unknown> | undefined
  const current = Array.isArray(profileBlock?.bundles) ? (profileBlock.bundles as string[]) : []

  const next: string[] = []
  const seen = new Set<string>()
  let changed = false
  const push = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    next.push(name)
  }
  for (const name of current) {
    const pkg = pluginManifest(home, profile, name)
    if (pkg && !pluginIsBundle(home, profile, name)) {
      // A non-bundle name in the layer list is exactly the misconfiguration that
      // breaks boot; mount it through the patch layer and drop it from bundles.
      if (addPluginInsert(home, profile, name)) changed = true
      continue
    }
    // 读不到 manifest 的名字(模板基础层如 @deepseek-ai/dsh-base 由运行时闭包提供,
    // 未必出现在 profile node_modules)保守保留在 bundles —— 硬转 insert 会让这类
    // bundle 层基础包以「普通插件」身份加载而 boot 失败(invalid plugin, received object)。
    push(name)
  }
  // Bundle-declaring dependencies that are missing from the layer list join it
  // (the harness would add them on the next `dsh plugin` command anyway).
  for (const name of Object.keys(deps)) {
    if (seen.has(name)) continue
    if (pluginIsBundle(home, profile, name)) { push(name); changed = true }
  }
  const same = next.length === current.length && next.every((n, i) => n === current[i])
  if (!same) {
    const nextManifest = { ...manifest, dsh: { ...dsh, profile: { ...(profileBlock ?? {}), bundles: next } } }
    writeFileSync(mp, JSON.stringify(nextManifest, null, 2) + '\n', 'utf8')
    changed = true
  }
  return { ok: true, changed, bundles: next }
}

/**
 * 递归删除目录内所有符号链接/junction(Windows 上 rmSync 遇到 junction 常抛
 * EPERM——junction 是重解析点,把它当目录枚举/删除会被系统拒绝)。先清链接,
 * 再删实体目录。占用中的链接跳过,交给后续 rmSync 的重试处理。
 */
function removeLinksInside(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const p = join(dir, name)
    let st
    try {
      st = lstatSync(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      try { unlinkSync(p) } catch { /* 占用中则留给 rmSync 重试 */ }
    } else if (st.isDirectory()) {
      removeLinksInside(p)
    }
  }
}

/**
 * 健壮的目录删除(Windows):先清内部 junction/symlink,再带重试 rmSync;
 * 仍被占用(如运行中的 dsh 实例持有插件文件句柄)时改名让原路径立即从本地库
 * 消失,后台再清;改名也失败才抛错。
 */
function removeDirForce(dir: string): void {
  if (!existsSync(dir)) return
  removeLinksInside(dir)
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    return
  } catch {
    // EPERM/EBUSY——目录可能被运行中的实例占用,走改名兜底。
  }
  const trash = `${dir}.deleting-${process.pid}-${Date.now()}`
  try {
    renameSync(dir, trash)
    rmSync(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    throw new Error(t(
      `目录被占用,无法删除 ${dir}。若插件正被运行中的实例加载,请先停止该实例再移除。`,
      `Directory is locked and could not be removed: ${dir}. If the plugin is loaded by a running instance, stop it first.`
    ))
  }
}

/**
 * Remove a plugin from the local library entirely: uninstall it from every
 * instance's profile (so no `file:` dependency dangles into a deleted folder),
 * then delete its source from pluginDir. Returns the affected instance ids so
 * the caller can restart the running ones.
 */
export async function removeFromLibrary(name: string): Promise<CmdResult> {
  const cfg = getConfig()
  const entry = scanLocal().find((p) => p.name === name)
  const affected: string[] = []
  for (const inst of cfg.instances) {
    const home = instanceDshHome(inst)
    const { installed } = listInstalled(home, inst.profile)
    if (!installed.some((p) => p.name === name)) continue
    setEnabled(home, inst.profile, name, false)
    const r = await remove(home, inst.profile, name)
    if (r.ok) affected.push(inst.id)
  }
  if (entry) {
    try {
      removeDirForce(entry.path)
    } catch (e) {
      return { ok: false, code: 1, error: e instanceof Error ? e.message : String(e), affected }
    }
  }
  // 插件已从本地库移除,连同它的显示名/备注一并清掉,
  // 避免「插件删了、名字还留在上面」的残留(此前推荐整合包功能遗留过这个问题)。
  if (cfg.pluginMeta?.[name]) setPluginMeta(name, { displayName: '', remark: '' })
  return { ok: true, code: 0, affected }
}

/** 批量删除本地插件(插件页勾选后一次移除):逐个 removeFromLibrary,汇总受影响的实例与失败项。 */
export async function removeFromLibraryMany(names: string[]): Promise<CmdResult> {
  const affected: string[] = []
  const warnings: string[] = []
  for (const name of names) {
    try {
      const r = await removeFromLibrary(name)
      for (const id of r.affected ?? []) if (!affected.includes(id)) affected.push(id)
      if (!r.ok) warnings.push(t(`「${name}」移除失败: ${r.error ?? ''}`, `"${name}" removal failed: ${r.error ?? ''}`))
    } catch (e) {
      warnings.push(t(`「${name}」移除出错: ${String(e)}`, `"${name}" removal error: ${String(e)}`))
    }
  }
  return { ok: true, code: 0, affected, warnings: warnings.length ? warnings : undefined }
}

/**
 * Download a recommended bundle (整合包):新建一个预配置实例(停止状态),并把每个社区
 * 插件 `dsh plugin add` 直装进该 profile。随包自研/预设组合(EAC)已下架,这里只处理
 * 纯社区包(如「新手起步套装」)。实例创建为停止状态(autoStart false),用户启动后可从
 * 插件页微调。
 */

/** 路径是否同一目录(Windows 忽略大小写)。 */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 让链接进本地库(pluginDir)的插件能解析 dsh 运行时依赖,否则这些插件一启动
 * 就报 `Cannot find package`。根因:链接插件是 `link:` 依赖,真实路径在 ~/.dsh 之外,
 * Node 向上找 node_modules 永远够不到 harness 维护的扁平回退层(~/.dsh/profiles/node_modules,
 * `healProfilesModuleFallback` 每次 boot 维护的完整运行时闭包),而若干宿主包
 * (如无 scope 的 schemastery / cosmokit、`@deepseek-ai/dsh-*`)都在该层解析。
 * 幂等修法(共享层,一次修好所有复用该库的 profile):
 *   1) 回退层补齐 harness 闭包之外的依赖(schemastery / cosmokit、dsh-side-session 的
 *      peer 依赖及其传递依赖)。源取目标 profile 的 node_modules;
 *      都没有时 `dsh plugin add` 直装 —— 纯依赖,不走 setEnabled
 *      (schemastery 不是 cordis 插件,写进 bundles / insert 会让 boot 失败)。
 *   2) 把回退层 junction 到 <pluginDir>/node_modules:链接插件从此像 profile 内插件一样
 *      解析整个 dsh 运行时闭包,且随 harness 每次 boot 自动愈合。
 */
export async function ensureRuntimeLinks(home: string, profile: string): Promise<void> {
  const cfg = getConfig()
  // D3:回退层固定挂在共享 home(所有 profile 的 node_modules 都指向它,单一源);
  // 每 home 的回退层内容由 dsh 自身 boot 时 healProfilesModuleFallback 维护,等价同源。
  const fallback = join(cfg.dshHome, 'profiles', 'node_modules')
  const profileNm = join(profileDir(home, profile), 'node_modules')
  mkdirSync(fallback, { recursive: true })

  for (const dep of ['schemastery', 'cosmokit']) {
    if (existsSync(join(fallback, dep))) continue
    const inProfile = join(profileNm, dep)
    if (!existsSync(inProfile)) {
      const { cmd, args, cwd, envPatch } = dshPluginCmd(home, profile, ['add', dep])
      const r = await runAsync(cmd, args, cwd, `install:${dep}`, process.platform === 'win32', envPatch)
      if (!r.ok) {
        taskLine('runtime', t(`安装运行时依赖 ${dep} 失败: ${r.error ?? ''}`, `Failed to install runtime dep ${dep}: ${r.error ?? ''}`), 'stderr')
        continue
      }
    }
    if (existsSync(inProfile)) cpSync(inProfile, join(fallback, dep), { recursive: true })
  }

  // 把回退层 junction 到本地库 node_modules。已是同一目标则跳过;占位的是旧版
  // 手动铺的实目录或悬空 junction 时,先移除再重建。
  const link = join(cfg.pluginDir, 'node_modules')
  let occupied = false
  try {
    if (lstatSync(link).isSymbolicLink()) {
      let target = ''
      try { target = realpathSync(link) } catch { /* 悬空链接 */ }
      if (target !== '' && samePath(target, fallback)) return
    }
    occupied = true
  } catch {
    /* pluginDir/node_modules 尚不存在 → 直接创建 */
  }
  if (occupied) rmSync(link, { recursive: true, force: true })
  mkdirSync(dirname(link), { recursive: true })
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, fallback])
    } else {
      symlinkSync(fallback, link, 'dir')
    }
  } catch (e) {
    taskLine('runtime', t(`链接本地库到运行时层失败: ${String(e)}`, `Failed to link the plugin library to the runtime layer: ${String(e)}`), 'stderr')
  }
}

export async function installBundle(
  bundleId: string,
  options?: { retrySpecs?: string[]; homeMode?: 'shared' | 'isolated'; home?: string },
): Promise<CmdResult> {
  const bundle = RECOMMENDED_BUNDLES.find((b) => b.id === bundleId)
  if (!bundle) return { ok: false, code: null, error: t('未找到整合包。', 'Bundle not found.') }
  const warnings: string[] = []
  const failedSpecs: string[] = []
  const retrySpecs = options?.retrySpecs
  // 重试模式(传入了上次失败的 spec 清单):跳过建实例与 profile 修复,只对清单里的插件重新直装。
  const retry = Array.isArray(retrySpecs) && retrySpecs.length > 0
  const community: Array<{ name?: string; spec?: string; flags?: string[] }> = retry
    ? (retrySpecs as string[]).map((spec) => ({ name: spec, spec }))
    : bundle.community

  // 总步骤 = 创建实例 + 每个插件直装。每个子步骤跑 dsh,本身就各自广播 install:
  // 任务;这里在步骤之间额外广播整合包的 0..1 总进度,让实例页的进度弹窗能显示整体
  // 百分比与当前阶段。重试模式只有插件步骤(实例已存在)。
  const total = (retry ? 0 : 1) + community.length
  const label = bundleTaskLabel(bundle)
  let done = 0
  const report = (phase: string): void => {
    taskProgress(label, total > 0 ? done / total : 1, phase)
  }
  const advance = (): void => {
    done += 1
    taskProgress(label, total > 0 ? done / total : 1)
  }

  try {
    // 1) 复用同名整合包实例(重试下载不产生重复实例);否则新建一个(停止状态)。
    //    重试模式要求实例已存在 —— 不存在说明整合包从未装成,应重新下载整个包。
    let inst = getConfig().instances.find((i) => i.name === bundle.name)
    if (!retry) {
      report(t('创建实例…', 'Creating instance…'))
      if (!inst) {
        const cfg = await addInstance({
          name: bundle.name,
          profile: bundle.profileBase ?? 'web',
          port: 0,
          autoStart: false,
          description: bundle.description,
          // 整合包实例的数据目录:下载弹窗里选的共享目标 home,或全新独立 DSH_HOME。
          homeMode: options?.homeMode,
          home: options?.homeMode === 'shared' ? options?.home : undefined
        })
        inst = cfg.instances[cfg.instances.length - 1]
      }
    }
    if (!inst) {
      return { ok: false, code: null, error: t('整合包实例不存在,请重新下载整合包。', 'Bundle instance not found; re-download the bundle.') }
    }
    const profile = inst.profile
    const home = instanceDshHome(inst)
    if (!retry) {
      // 修复:旧版 launcher 会把非 bundle 插件写进 bundles,导致 boot 失败;
      // 修复后 bundles 只含 bundle 层,非 bundle 插件改以 insert 挂载(幂等)。
      repairProfile(home, profile)
      advance()
    }

    // 2) 插件:逐个 `dsh plugin add <spec>` 直装最新版。
    let n = 0
    for (const p of community) {
      const spec = p.spec || p.name
      if (!spec) continue
      n += 1
      const phase = t(`安装社区插件 ${n}/${community.length}:${p.name ?? spec}…`, `Installing community plugin ${n}/${community.length}: ${p.name ?? spec}…`)
      report(phase)
      const r = await install(home, profile, spec, undefined, p.flags)
      if (r.ok) {
        taskLine(label, `✔ ${p.name ?? spec}`)
      } else {
        warnings.push(t(`社区插件「${p.name ?? spec}」安装失败: ${r.error ?? ''}`, `Community plugin "${p.name ?? spec}" failed to install: ${r.error ?? ''}`))
        failedSpecs.push(spec)
        taskLine(label, `✖ ${p.name ?? spec}: ${r.error ?? ''}`, 'stderr')
      }
      advance()
    }

    taskProgress(label, 1, t('完成', 'Done'))
    taskDone(label, 0)
    return { ok: true, code: 0, warnings, bundleFailed: failedSpecs.length ? failedSpecs : undefined }
  } catch (e) {
    taskDone(label, 1)
    return { ok: false, code: null, error: String(e) }
  }
}

// --- maintenance ---

/** `pnpm install` in the harness repo — repairs missing deps like zod. */
export function repairDeps(): Promise<CmdResult> {
  if (getConfig().installMode === 'bundled') {
    return Promise.resolve({ ok: false, code: 1, error: t('内置模式下无需修复源码依赖', 'No need to repair source deps in bundled mode') })
  }
  return pnpmCmd(['install'], getConfig().harnessRepo, 'repair')
}

/** Run the configured build command (default `pnpm run build`) in the harness repo. */
export function rebuild(): Promise<CmdResult> {
  const cfg = getConfig()
  if (cfg.installMode === 'bundled') {
    return Promise.resolve({ ok: false, code: 1, error: t('内置模式下无需重新构建源码', 'No need to rebuild the source in bundled mode') })
  }
  const tokens = cfg.buildCmd.trim().split(/\s+/)
  const cmd = tokens[0] ?? 'pnpm'
  const args = tokens.slice(1)
  return runAsync(cmd, args, cfg.harnessRepo, 'build', process.platform === 'win32')
}

// --- downloads ---

// `git` must never sit waiting for a credential prompt — the launcher has no
// terminal to answer it, and a private/missing repo would otherwise hang the
// install forever. GIT_TERMINAL_PROMPT=0 makes git fail fast instead.
const GIT_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' }
const GIT_TIMEOUT_MS = 6 * 60_000

// --- portable git bootstrap ---
//
// Plugin / harness downloads are done with `git clone`, so a machine with no
// Git at all couldn't install anything from the market. On first need we probe
// for a system git and, if absent, fetch the official portable "MinGit" (a
// minimal Git for Windows build) into the runtime root and use it by absolute
// path — no installer, no admin rights.

// Pin a MinGit release known to exist on both the mirror and GitHub.
const PORTABLE_GIT_VERSION = '2.47.1'
const PORTABLE_GIT_MIRROR = (v: string) => `https://registry.npmmirror.com/-/binary/git-for-windows/v${v}.windows.1/MinGit-${v}-64-bit.zip`
const PORTABLE_GIT_GITHUB = (v: string) => `https://github.com/git-for-windows/git/releases/download/v${v}.windows.1/MinGit-${v}-64-bit.zip`

/** The portable Git exe inside the runtime root, or null if not downloaded yet. */
function portableGitExe(): string | null {
  const root = getConfig().runtimeRoot
  const candidates = ['cmd', 'bin'].map((sub) => join(root, 'git', sub, 'git.exe'))
  return candidates.find((p) => existsSync(p)) ?? null
}

// undefined = not probed this session, null = use the system git, string = portable git path.
let resolvedGit: string | null | undefined

/** True when `git --version` succeeds within 5 s (a system git exists). */
function systemGitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let p: ReturnType<typeof spawn>
    try {
      p = spawn('git', ['--version'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      try { p.kill() } catch { /* already gone */ }
      resolve(false)
    }, 5000)
    p.on('error', () => { clearTimeout(timer); resolve(false) })
    p.on('close', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
}

/**
 * Resolve the `git` executable for clones / pulls: prefer a system git; if the
 * machine has none, download the portable MinGit (mirror first, GitHub as
 * fallback) into the runtime root and return its absolute path. Memoized for
 * the session so the probe only runs once.
 */
async function ensureGit(label: string): Promise<{ ok: true; exe: string } | { ok: false; error: string }> {
  if (resolvedGit === null) return { ok: true, exe: 'git' }
  if (resolvedGit !== undefined) return { ok: true, exe: resolvedGit }

  if (await systemGitAvailable()) {
    resolvedGit = null
    taskLine(label, t('[download] 检测到系统 Git,直接使用。', '[download] System Git found — using it.'))
    return { ok: true, exe: 'git' }
  }

  taskLine(label, t('[download] 未检测到 Git,正在下载便携版 Git(约 45MB)…', '[download] Git not found — downloading portable Git (~45MB)…'))
  const root = getConfig().runtimeRoot
  const stage = join(root, '.git-stage')
  const zipPath = join(stage, `MinGit-${PORTABLE_GIT_VERSION}-64-bit.zip`)
  const urls = [PORTABLE_GIT_MIRROR(PORTABLE_GIT_VERSION), PORTABLE_GIT_GITHUB(PORTABLE_GIT_VERSION)]
  mkdirSync(stage, { recursive: true })

  let downloaded = false
  for (const url of urls) {
    taskProgress(label, 0.1, t('下载便携版 Git', 'Downloading portable Git'))
    try {
      await downloadFile(url, zipPath, progressLine(label))
      downloaded = true
      break
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskLine(label, t(`[download] 从 ${new URL(url).host} 下载失败: ${message}`, `[download] Download from ${new URL(url).host} failed: ${message}`), 'stderr')
    }
  }
  if (!downloaded) {
    taskDone(label, 1)
    return { ok: false, error: t('检测到本机未安装 Git,且自动下载失败。请前往官网下载安装:https://git-scm.com/download/win', 'Git is not installed on this machine and auto-download failed. Please install it from: https://git-scm.com/download/win') }
  }

  taskProgress(label, 0.8, t('解压 Git', 'Extracting Git'))
  const gitDir = join(root, 'git')
  if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true })
  mkdirSync(gitDir, { recursive: true })
  const okExtract = await extractZip(zipPath, gitDir, label)
  rmSync(stage, { recursive: true, force: true })
  const exe = portableGitExe()
  if (!okExtract || !exe) {
    taskDone(label, 1)
    return { ok: false, error: t('检测到本机未安装 Git,且便携版解压失败。请前往官网下载安装:https://git-scm.com/download/win', 'Git is not installed on this machine and portable extraction failed. Please install it from: https://git-scm.com/download/win') }
  }

  resolvedGit = exe
  taskLine(label, t(`[download] ✔ 便携版 Git 就绪: ${exe}`, `[download] ✔ Portable Git ready: ${exe}`))
  taskProgress(label, 1, t('Git 就绪', 'Git ready'))
  return { ok: true, exe }
}

/**
 * Env for running the resolved git: GIT_TERMINAL_PROMPT=0 plus the portable
 * git tree on PATH so its bundled helpers (git-remote-http, ssh, …) resolve.
 */
function gitEnvFor(exe: string): NodeJS.ProcessEnv {
  if (exe === 'git') return GIT_ENV
  const binDir = dirname(exe) // …/git/cmd
  const root = join(binDir, '..')
  return { ...GIT_ENV, PATH: `${root}${delimiter}${binDir}${delimiter}${process.env.PATH ?? ''}` }
}

/** Attach a personal access token to an https GitHub clone URL (for private repos). */
function authedCloneUrl(url: string, token: string | undefined): string {
  if (!token) return url
  return url.replace('https://github.com/', `https://${encodeURIComponent(token)}@github.com/`)
}

/**
 * A clone that was killed mid-download leaves a directory containing only a
 * `.git` skeleton (no worktree). That is not a usable repo — a later download
 * would see the `.git` and try a doomed `git pull` on it. Detect and wipe it
 * so the next attempt starts from a clean shallow clone.
 */
function isIncompleteGitDir(dir: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    return entries.length === 1 && entries[0].name === '.git' && entries[0].isDirectory()
  } catch {
    return false
  }
}

/**
 * Shallow clone args. Plugin repos are code, not history — `--depth 1` cuts the
 * transfer from the full repo size to a single snapshot, which is the difference
 * between a 16 s install and a 6-minute stall that times out (e.g. a 78 MB repo
 * over a slow connection). `--branch` must precede the URL, so we build the full
 * arg list here.
 */
function cloneArgs(url: string, target: string, ref?: string): string[] {
  const args = ['clone', '--depth', '1']
  if (ref) args.push('--branch', ref)
  args.push(url, target)
  return args
}

/**
 * A repo can carry the `dsh-plugin` topic without being installable as a plugin
 * — e.g. skin-distribution monorepos whose real package lives in a subdirectory
 * (dsh-deep-whale ships the installable skin under `maid-atelier/`). Only install
 * dirs that actually look like a dsh plugin, so a bad download never leaves a
 * broken `link:`/`file:` dependency in the profile that breaks the harness boot.
 */
function looksLikeDshPlugin(target: string): { ok: boolean; reason?: string } {
  const pkg = readJson(join(target, 'package.json'))
  if (!pkg || typeof pkg !== 'object') {
    return {
      ok: false,
      reason: t('仓库根目录没有 package.json — 它不是可直接安装的 dsh 插件(可能是皮肤/合集仓库,可装的子包在子目录里)。', 'The repo has no package.json at its root — not an installable dsh plugin (it may be a skin/collection repo with the real package in a subdirectory).')
    }
  }
  if (typeof pkg.name !== 'string' || !pkg.name) {
    return { ok: false, reason: t('package.json 缺少 name 字段。', 'package.json is missing the name field.') }
  }
  if (!pkg.dsh || typeof pkg.dsh !== 'object') {
    return {
      ok: false,
      reason: t(`该包(${String(pkg.name)})没有 dsh 配置,不是 dsh 插件。`, `Package (${String(pkg.name)}) has no dsh config — not a dsh plugin.`)
    }
  }
  return { ok: true }
}

/**
 * Cheap pre-flight before cloning: skip repos that provably contain no
 * `package.json` anywhere, so we don't pull tens of MB only to reject them.
 * A repo may legitimately have no root package.json (plugins shipped in
 * subdirectories, e.g. `dsh-deep-whale` keeps the installable skin under
 * `maid-atelier/`) — this only rejects repos with no package.json at all.
 * Fail-open: if the API is rate-limited or flaky we return null and still
 * clone, since the local scan protects the profile either way.
 */
async function hasAnyPackageJson(gh: { owner: string; repo: string }): Promise<boolean | null> {
  try {
    const res = await net.fetch(
      `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/git/trees/HEAD?recursive=1`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-launcher/1.0.0' } }
    )
    if (res.status === 404) return false
    if (res.status === 401 || res.status === 403) return null // rate-limited / auth — fail open
    if (!res.ok) return null
    const body = (await res.json()) as { tree?: Array<{ path?: string }> } | null
    const paths = (body?.tree ?? []).map((t) => t.path ?? '')
    return paths.some((p) => p === 'package.json' || p.endsWith('/package.json'))
  } catch {
    return null
  }
}

/**
 * Find plugin packages inside a cloned repo whose own root is not one (e.g.
 * skin/collection repos). Scans immediate subdirectories for `package.json`
 * files that declare a `dsh` config — the same shape `looksLikeDshPlugin`
 * checks. Skips `node_modules` / `.git`.
 */
function findPluginSubpackages(target: string): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = []
  let entries: string[]
  try {
    entries = readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git')
      .map((e) => e.name)
  } catch {
    return out
  }
  for (const name of entries) {
    const pkg = readJson(join(target, name, 'package.json'))
    const dsh = pkg?.dsh
    if (pkg && typeof pkg.name === 'string') {
      if (dsh && typeof dsh === 'object') out.push({ path: name, name: pkg.name })
    }
  }
  return out
}

/**
 * One-click harness install: clone/update the repo, install deps, then
 * auto-configure the launcher's paths so it points at the downloaded repo.
 */
export async function downloadHarness(): Promise<CmdResult> {
  const cfg = getConfig()
  const url = cfg.harnessRepoUrl.trim() || 'https://github.com/deepseek-ai/deepseek-harness.git'
  const target = resolve(cfg.harnessRepo || join(homedir(), 'deepseek-harness'))
  const label = 'download:harness'

  const git = await ensureGit(label)
  if (!git.ok) {
    taskDone(label, 1)
    return { ok: false, code: null, error: git.error }
  }
  taskProgress(label, 0.1, t('拉取最新代码…', 'Fetching latest code…'))
  const gitEnv = gitEnvFor(git.exe)

  if (isIncompleteGitDir(target)) rmSync(target, { recursive: true, force: true })
  const isGit = existsSync(join(target, '.git'))
  if (isGit) {
    const pull = await runAsync(git.exe, ['-C', target, 'pull', '--ff-only'], process.cwd(), label, process.platform === 'win32', gitEnv, GIT_TIMEOUT_MS)
    if (!pull.ok) taskLine(label, t('[download] 拉取未完成(可能有本地改动),继续使用现有代码。', '[download] Pull incomplete (possible local changes); using existing code.'), 'stderr')
  } else if (existsSync(target) && readdirSync(target).length > 0) {
    taskLine(label, t('[download] 目标目录非空且非 git 仓库,跳过克隆,仅安装依赖。', '[download] Target dir is non-empty and not a git repo; skipping clone, installing deps only.'), 'stderr')
    taskDone(label, 0)
  } else {
    const clone = await runAsync(git.exe, cloneArgs(authedCloneUrl(url, cfg.githubToken), target), process.cwd(), label, process.platform === 'win32', gitEnv, GIT_TIMEOUT_MS, cfg.githubToken)
    if (!clone.ok) {
      // Wipe the partial clone (may only contain `.git`) so a retry starts fresh.
      rmSync(target, { recursive: true, force: true })
      taskDone(label, clone.code ?? 1)
      return clone
    }
  }

  taskProgress(label, 0.45, t('代码已就绪,安装依赖…', 'Code ready, installing dependencies…'))
  taskLine(label, t('[download] 安装依赖 (pnpm install)…', '[download] Installing dependencies (pnpm install)…'))
  const install = await pnpmCmd(['install'], target, 'repair')
  if (!install.ok) {
    taskDone(label, install.code ?? 1)
    return install
  }

  // Auto-configure paths so the launcher points at the freshly-downloaded repo.
  const launch = existsSync(join(target, 'apps', 'cli', 'lib', 'bin.js')) ? ['apps/cli/lib/bin.js'] : cfg.launchArgs
  const next = setConfig({
    harnessRepo: target,
    harnessRepoUrl: url,
    dshHome: cfg.dshHome || join(homedir(), '.dsh'),
    profile: cfg.profile || 'web',
    launchArgs: launch,
    nodePath: cfg.nodePath || 'node',
    port: cfg.port || 3080
  })
  taskLine(label, t(`[download] ✔ 完成 — harnessRepo=${next.harnessRepo}`, `[download] ✔ Done — harnessRepo=${next.harnessRepo}`))
  taskLine(label, t(`[download] 启动命令: ${next.nodePath} ${[...next.launchArgs, next.profile].join(' ')}`, `[download] Launch command: ${next.nodePath} ${[...next.launchArgs, next.profile].join(' ')}`))
  taskDone(label, 0)
  return { ok: true, code: 0 }
}

/**
 * Download a plugin from a GitHub repo URL into the shared local library
 * (pluginDir) only — it is NOT enabled or installed into any instance. The user
 * enables it later from the plugin management page, which marks instances as
 * awaiting a manual restart. The `_profile` argument is kept for IPC signature
 * stability but is no longer used.
 */
export async function downloadPlugin(url: string, subdir?: string, _profile?: string): Promise<CmdResult> {
  const cfg = getConfig()
  const gh = parseGitHubUrl(url)
  if (!gh) return { ok: false, code: null, error: t(`无法识别的 GitHub 地址: ${url}`, `Unrecognized GitHub URL: ${url}`) }
  const label = `clone:${gh.repo}`
  const target = join(cfg.pluginDir, gh.repo)

  // Pre-flight: only reject repos with no package.json anywhere — a repo may
  // legitimately ship its plugin in a subdirectory (skins/collections).
  if (await hasAnyPackageJson(gh) === false) {
    return {
      ok: false,
      code: null,
      error: t(
        `该仓库没有 package.json — 它不是 dsh 插件仓库。`,
        `This repo has no package.json anywhere — it is not a dsh plugin repo.`
      )
    }
  }

  // The download itself is a git clone — ensure a git exists, fetching the
  // portable one when the machine has none. Only reached for valid plugin
  // repos, so we never pay the ~45MB download for a repo we'd reject anyway.
  const git = await ensureGit(label)
  if (!git.ok) {
    taskDone(label, 1)
    return { ok: false, code: null, error: git.error }
  }
  const gitEnv = gitEnvFor(git.exe)

  if (!existsSync(cfg.pluginDir)) mkdirSync(cfg.pluginDir, { recursive: true })

  if (isIncompleteGitDir(target)) rmSync(target, { recursive: true, force: true })
  if (existsSync(join(target, '.git'))) {
    const pull = await runAsync(git.exe, ['-C', target, 'pull', '--ff-only'], process.cwd(), label, process.platform === 'win32', gitEnv, GIT_TIMEOUT_MS)
    if (!pull.ok) taskLine(label, t('[download] 拉取未完成,使用现有代码。', '[download] Pull incomplete; using existing code.'), 'stderr')
  } else {
    const clone = await runAsync(git.exe, cloneArgs(authedCloneUrl(gh.cloneUrl, cfg.githubToken), target, gh.ref), process.cwd(), label, process.platform === 'win32', gitEnv, GIT_TIMEOUT_MS, cfg.githubToken)
    if (!clone.ok) {
      // Wipe the partial clone (may only contain `.git`) so a retry starts fresh.
      rmSync(target, { recursive: true, force: true })
      taskDone(label, clone.code ?? 1)
      return clone
    }
  }

  // Resolve the installable package directory inside the clone: an explicit
  // subdir wins, then the repo root, then the single subpackage, then ask.
  const rootCheck = looksLikeDshPlugin(target)
  const subpkgs = findPluginSubpackages(target)

  let pkgDir: string
  if (subdir) {
    // Explicit choice from the UI chooser — validate, guarding path traversal.
    const resolved = resolve(target, subdir)
    if (resolved !== target && !resolved.startsWith(target + sep)) {
      taskDone(label, 1)
      return { ok: false, code: null, error: t('无效的子包路径。', 'Invalid subpackage path.') }
    }
    const subCheck = looksLikeDshPlugin(resolved)
    if (!subCheck.ok) {
      taskDone(label, 1)
      return { ok: false, code: null, error: subCheck.reason }
    }
    pkgDir = resolved
  } else if (rootCheck.ok) {
    pkgDir = target
  } else if (subpkgs.length === 1) {
    pkgDir = join(target, subpkgs[0].path)
    taskLine(label, t(`[download] 检测到插件子包 <${subpkgs[0].name}>(${subpkgs[0].path}),将随仓库一并下载到本地库。`, `[download] Found plugin subpackage <${subpkgs[0].name}> (${subpkgs[0].path}); downloading with the repo into the local library.`))
  } else if (subpkgs.length > 1) {
    taskLine(label, t(`[download] 该仓库包含 ${subpkgs.length} 个插件子包,请选择要下载的。`, `[download] This repo ships ${subpkgs.length} plugin subpackages — pick one to download.`), 'stderr')
    taskDone(label, 1)
    return {
      ok: false,
      code: null,
      error: t('该仓库包含多个插件包,请选择要下载的。', 'This repo contains several plugin packages — pick one to download.'),
      packages: subpkgs
    }
  } else {
    taskLine(label, t(`[download] 已下载到 ${target},但它不是可下载的 dsh 插件。`, `[download] Downloaded to ${target}, but it is not a downloadable dsh plugin.`), 'stderr')
    taskDone(label, 1)
    return { ok: false, code: null, error: t('该仓库没有任何可下载的 dsh 插件包。', 'This repo has no downloadable dsh plugin package.') }
  }

  taskLine(label, t(`[download] 已下载到本地库: ${pkgDir} — 可在「插件」页启用。`, `[download] Downloaded to the local library: ${pkgDir} — enable it from the Plugins page.`))
  taskDone(label, 0)
  return { ok: true, code: 0 }
}
