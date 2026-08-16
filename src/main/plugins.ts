import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { net } from 'electron'
import { getConfig, setConfig } from './config'
import { t } from './i18n'
import { bundledEnv, resolveBundledNode } from './runtime'
import { runAsync, taskDone, taskLine } from './task'
import { parseGitHubUrl } from '../shared/github'
import type { CmdResult, InstalledPlugin, LocalPlugin, LocalStatus, PluginListResult } from '../shared/types'

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function profileDir(profile: string): string {
  return join(getConfig().dshHome, 'profiles', profile)
}

function pnpmCmd(args: string[], cwd: string, label: string): Promise<CmdResult> {
  const cfg = getConfig()
  return runAsync(cfg.pnpm, args, cwd, label, process.platform === 'win32')
}

function dshPluginCmd(profile: string, extra: string[]): { cmd: string; args: string[]; cwd: string; envPatch?: NodeJS.ProcessEnv } {
  const cfg = getConfig()
  if (cfg.installMode === 'bundled') {
    // Run the bundled CLI; PATH is prefixed so its internal pnpm resolves to the portable copy.
    return {
      cmd: resolveBundledNode() ?? cfg.nodePath,
      args: [...cfg.launchArgs, 'plugin', '--profile', profile, ...extra],
      cwd: cfg.runtimeRoot,
      envPatch: bundledEnv()
    }
  }
  return {
    cmd: cfg.nodePath,
    args: [...cfg.launchArgs, 'plugin', '--profile', profile, ...extra],
    cwd: cfg.harnessRepo,
    envPatch: undefined
  }
}

// --- reads ---

export function listInstalled(profile: string): { installed: InstalledPlugin[]; bundles: string[] } {
  const dir = profileDir(profile)
  const manifest = readJson(join(dir, 'package.json'))
  const deps = (manifest?.dependencies as Record<string, string> | undefined) ?? {}
  const dsh = manifest?.dsh as Record<string, unknown> | undefined
  const profileBlock = dsh?.profile as Record<string, unknown> | undefined
  const bundles: string[] = Array.isArray(profileBlock?.bundles) ? (profileBlock.bundles as string[]) : []

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
    if (spec.startsWith('file:')) {
      const p = spec.slice('file:'.length)
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
      enabled: bundles.includes(name),
      isBundle,
      inBox: false
    })
  }
  return { installed, bundles }
}

export function listLocal(): LocalPlugin[] {
  const cfg = getConfig()
  const { installed } = listInstalled(cfg.profile)
  const names = new Map<string, LocalStatus>(installed.map((p) => [p.name, p.enabled ? 'enabled' : 'installed']))
  const out: LocalPlugin[] = []
  if (!existsSync(cfg.pluginDir)) return out
  for (const entry of readdirSync(cfg.pluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkg = readJson(join(cfg.pluginDir, entry.name, 'package.json'))
    if (!pkg?.name) continue
    const name = String(pkg.name)
    out.push({
      name,
      version: String(pkg.version ?? ''),
      description: String(pkg.description ?? ''),
      path: join(cfg.pluginDir, entry.name),
      isBundle: Boolean((pkg.dsh as Record<string, unknown> | undefined)?.bundle),
      platform: String(((pkg.dsh as Record<string, unknown> | undefined)?.client as Record<string, unknown> | undefined)?.platform ?? '') || null,
      status: names.get(name) ?? 'not-installed'
    })
  }
  return out
}

export function listPlugins(): PluginListResult {
  const cfg = getConfig()
  const { installed, bundles } = listInstalled(cfg.profile)
  return { profile: cfg.profile, bundles, installed, local: listLocal() }
}

// --- mutations ---

/** Install a plugin (local path or npm spec) into a profile via `dsh plugin add`. */
export async function install(profile: string, spec: string): Promise<CmdResult> {
  const target = /^\.{1,2}[/\\]/.test(spec) ? resolve(process.cwd(), spec) : spec
  const { cmd, args, cwd, envPatch } = dshPluginCmd(profile, ['add', target])
  return runAsync(cmd, args, cwd, `install:${target}`, process.platform === 'win32', envPatch)
}

export async function remove(profile: string, name: string): Promise<CmdResult> {
  const { cmd, args, cwd, envPatch } = dshPluginCmd(profile, ['remove', name])
  return runAsync(cmd, args, cwd, `remove:${name}`, process.platform === 'win32', envPatch)
}

/** Toggle a bundle in the profile manifest without touching the installed dependency. */
export function setEnabled(profile: string, name: string, enabled: boolean): { ok: boolean; changed: boolean; bundles: string[] } {
  const dir = profileDir(profile)
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
    if (pkg && typeof pkg.name === 'string' && dsh && typeof dsh === 'object') {
      out.push({ path: name, name: pkg.name })
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

  if (isIncompleteGitDir(target)) rmSync(target, { recursive: true, force: true })
  const isGit = existsSync(join(target, '.git'))
  if (isGit) {
    const pull = await runAsync('git', ['-C', target, 'pull', '--ff-only'], process.cwd(), label, process.platform === 'win32', GIT_ENV, GIT_TIMEOUT_MS)
    if (!pull.ok) taskLine(label, t('[download] 拉取未完成(可能有本地改动),继续使用现有代码。', '[download] Pull incomplete (possible local changes); using existing code.'), 'stderr')
  } else if (existsSync(target) && readdirSync(target).length > 0) {
    taskLine(label, t('[download] 目标目录非空且非 git 仓库,跳过克隆,仅安装依赖。', '[download] Target dir is non-empty and not a git repo; skipping clone, installing deps only.'), 'stderr')
    taskDone(label, 0)
  } else {
    const clone = await runAsync('git', cloneArgs(authedCloneUrl(url, cfg.githubToken), target), process.cwd(), label, process.platform === 'win32', GIT_ENV, GIT_TIMEOUT_MS, cfg.githubToken)
    if (!clone.ok) {
      // Wipe the partial clone (may only contain `.git`) so a retry starts fresh.
      rmSync(target, { recursive: true, force: true })
      taskDone(label, clone.code ?? 1)
      return clone
    }
  }

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
 * Download a plugin from a GitHub repo URL: clone into pluginDir, then install
 * it into the current profile via `dsh plugin add <path>`.
 */
export async function downloadPlugin(url: string, subdir?: string): Promise<CmdResult> {
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

  if (!existsSync(cfg.pluginDir)) mkdirSync(cfg.pluginDir, { recursive: true })

  if (isIncompleteGitDir(target)) rmSync(target, { recursive: true, force: true })
  if (existsSync(join(target, '.git'))) {
    const pull = await runAsync('git', ['-C', target, 'pull', '--ff-only'], process.cwd(), label, process.platform === 'win32', GIT_ENV, GIT_TIMEOUT_MS)
    if (!pull.ok) taskLine(label, t('[download] 拉取未完成,使用现有代码。', '[download] Pull incomplete; using existing code.'), 'stderr')
  } else {
    const clone = await runAsync('git', cloneArgs(authedCloneUrl(gh.cloneUrl, cfg.githubToken), target, gh.ref), process.cwd(), label, process.platform === 'win32', GIT_ENV, GIT_TIMEOUT_MS, cfg.githubToken)
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
    taskLine(label, t(`[download] 检测到插件子包 <${subpkgs[0].name}>(${subpkgs[0].path}),自动安装它。`, `[download] Found plugin subpackage <${subpkgs[0].name}> (${subpkgs[0].path}); installing it.`))
  } else if (subpkgs.length > 1) {
    taskLine(label, t(`[download] 该仓库包含 ${subpkgs.length} 个插件子包,请选择要安装的。`, `[download] This repo ships ${subpkgs.length} plugin subpackages — pick one to install.`), 'stderr')
    taskDone(label, 1)
    return {
      ok: false,
      code: null,
      error: t('该仓库包含多个插件包,请选择要安装的。', 'This repo contains several plugin packages — pick one to install.'),
      packages: subpkgs
    }
  } else {
    taskLine(label, t(`[download] 已下载到 ${target},但它不是可安装的 dsh 插件 — 已跳过安装。`, `[download] Downloaded to ${target}, but it is not an installable dsh plugin — skipped install.`), 'stderr')
    taskDone(label, 1)
    return { ok: false, code: null, error: t('该仓库没有任何可安装的 dsh 插件包。', 'This repo has no installable dsh plugin package.') }
  }

  taskLine(label, t(`[download] 已就绪: ${pkgDir} → 安装到 profile "${cfg.profile}"`, `[download] Ready: ${pkgDir} → installing into profile "${cfg.profile}"`))
  taskDone(label, 0)
  return install(cfg.profile, pkgDir)
}
