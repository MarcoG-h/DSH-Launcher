import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import * as yaml from 'js-yaml'
import { net } from 'electron'
import { getConfig, setConfig } from './config'
import { addInstance, getActiveInstance, instanceDshHome } from './instances'
import { t } from './i18n'
import { bundledEnv, downloadFile, extractZip, progressLine, resolveBundledNode } from './runtime'
import { runAsync, taskDone, taskLine, taskProgress } from './task'
import { bundleTaskLabel, RECOMMENDED_BUNDLES } from '../shared/bundles'
import { parseGitHubUrl } from '../shared/github'
import { classifyPnpmFailure, pluginArgsFor } from './pnpm-compat'
import type { BundlePlugin, CmdResult, InstalledPlugin, LocalPlugin, PluginCellStatus, PluginListResult, PluginMatrixColumn, PluginMatrixResult, PluginMeta, RecommendedBundle } from '../shared/types'

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
  // pnpm 9 在 workspace 根目录 add/remove 需要 -w;仅当 profile 有 pnpm-workspace.yaml 时注入。
  const fixed = pluginArgsFor(join(home, 'profiles', profile), extra)
  if (cfg.installMode === 'bundled') {
    // Run the bundled CLI; PATH is prefixed so its internal pnpm resolves to the portable copy.
    return {
      cmd: resolveBundledNode() ?? cfg.nodePath,
      args: [...cfg.launchArgs, 'plugin', '--profile', profile, ...fixed],
      cwd: cfg.runtimeRoot,
      envPatch: { ...bundledEnv(), DSH_HOME: home }
    }
  }
  return {
    cmd: cfg.nodePath,
    args: [...cfg.launchArgs, 'plugin', '--profile', profile, ...fixed],
    cwd: cfg.harnessRepo,
    envPatch: { DSH_HOME: home }
  }
}

/**
 * 执行一次 dsh plugin 命令,带 pnpm 陷阱自动恢复(照抄 dsh-market 的 withHoistRecovery):
 * - pnpm 大版本漂移(hoist-pattern-diff)→ 重建 install 后重试一次
 * - release-age 锁 → 一次性 minimumReleaseAge=0 绕过重试
 * - GitHub 直装仓库拉取失败(git-network)→ 原样重试一次,仍失败依次走镜像重写
 * - 模型引擎二进制下载失败(llama-binary)→ 原样重试一次
 * - 瞬时网络失败 → 原样重试一次
 * - fetch 超时 → 更长 fetchTimeout 重试一次
 * - fetch 404(镜像未同步)→ 短延迟重试镜像,再直连官方 npmjs 兜底
 * 失败仍存活时,若识别出具体陷阱,把可操作提示附加到 error(替代原始报错墙)。
 */
async function runPluginCommand(home: string, profile: string, extra: string[], label: string, envPatch?: NodeJS.ProcessEnv): Promise<CmdResult> {
  const runOnce = (args: string[], patch?: NodeJS.ProcessEnv): Promise<CmdResult> => {
    const { cmd, args: base, cwd, envPatch: baseEnv } = dshPluginCmd(home, profile, args)
    return runAsync(cmd, base, cwd, label, process.platform === 'win32', { ...baseEnv, ...envPatch, ...patch })
  }
  const ok = (r: CmdResult): boolean => r.ok
  let r = await runOnce(extra)
  if (ok(r)) return r
  const output = r.stderr ?? ''
  const failure = classifyPnpmFailure(output)
  if (failure?.code === 'hoist-pattern-diff') {
    taskLine(label, t('[install] node_modules 由旧版 pnpm 创建,正在重建后重试…', '[install] node_modules was created by a different pnpm major; rebuilding and retrying…'), 'stderr')
    await runOnce(['install', '--no-frozen-lockfile'])
    r = await runOnce(extra)
  } else if (failure?.code === 'release-age-violation' && (extra[0] === 'add' || extra[0] === 'remove')) {
    taskLine(label, t('[install] pnpm 安全等待期拦截,正在放行重试…', '[install] pnpm fresh-release hold; bypassing and retrying…'), 'stderr')
    r = await runOnce([extra[0], '--config.minimumReleaseAge=0', ...extra.slice(1)])
  } else if (failure?.code === 'git-network' && (extra[0] === 'add' || extra[0] === 'remove')) {
    // GitHub 直装插件拉取仓库失败:git 的 stderr 不在瞬时网络正则里。先原样重试一次
    // (瞬时抖动),仍失败就依次用镜像重写重试(GIT_CONFIG_* 进程级注入,不改用户全局配置)。
    r = await runOnce(extra)
    for (const mirror of GIT_MIRROR_REWRITES) {
      if (ok(r)) break
      taskLine(label, t(`[install] 直连 GitHub 失败,改用镜像 ${mirror.name} 重试…`, `[install] direct GitHub fetch failed; retrying via mirror ${mirror.name}…`), 'stderr')
      r = await runOnce(extra, mirror.env)
    }
  } else if (failure?.code === 'llama-binary' && (extra[0] === 'add' || extra[0] === 'remove')) {
    // 模型引擎二进制下载失败(可能瞬时网络抖动),原样重试一次再判死。
    taskLine(label, t('[install] 下载 llama 引擎二进制失败,自动重试一次…', '[install] llama engine binary download failed; retrying once…'), 'stderr')
    r = await runOnce(extra)
  } else if (failure?.code === 'fetch-404' && (extra[0] === 'add' || extra[0] === 'remove')) {
    // 刚发布的包 registry/镜像可能还没同步完:先短等重试镜像,仍 404 就直连官方 npmjs
    // (发布源头,一定是最新,且公开包无需登录)。
    taskLine(label, t('[install] 某个依赖在 registry 上暂时取不到(可能刚发布、镜像未同步),稍候重试…', '[install] a dependency is momentarily unavailable on the registry (fresh publish / mirror not synced); retrying shortly…'), 'stderr')
    await delay(1500)
    r = await runOnce(extra)
    if (!ok(r)) {
      taskLine(label, t('[install] 镜像仍未同步,改用官方 npmjs 源重试一次…', '[install] mirror still not synced; retrying once via the official npmjs registry…'), 'stderr')
      r = await runOnce([extra[0], '--config.registry=https://registry.npmjs.org/', ...extra.slice(1)])
    }
  } else if (failure?.code === 'transient-network' && (extra[0] === 'add' || extra[0] === 'remove')) {
    taskLine(label, t('[install] 拉取依赖时网络临时失败,自动重试一次…', '[install] transient network failure; retrying once…'), 'stderr')
    r = await runOnce(extra)
  } else if (failure?.code === 'fetch-timeout' && (extra[0] === 'add' || extra[0] === 'remove')) {
    taskLine(label, t('[install] 下载超时,用更长的请求超时重试一次…', '[install] download timed out; retrying once with a longer fetch timeout…'), 'stderr')
    r = await runOnce([extra[0], '--config.fetchTimeout=600000', ...extra.slice(1)])
  }
  if (!ok(r) && failure !== null) {
    r = { ...r, error: failure.message }
  }
  return r
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
    if (entry.name.startsWith('.deleting-')) {
      // 删除改名兜底遗留的残留:扫描时自动清理(未被占用的直接删),不显示成行。
      const p = join(cfg.pluginDir, entry.name)
      try {
        rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      } catch {
        // 长路径(旧版反复改名叠加)/Windows 句柄:改名成固定短名再删。
        try {
          const short = join(cfg.pluginDir, `.deleting-${process.pid}`)
          if (p !== short) {
            if (existsSync(short)) rmSync(short, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
            renameSync(p, short)
          }
          rmSync(short, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
        } catch { /* 仍被占用,留待下次扫描清理 */ }
      }
      continue
    }
    const entryPath = join(cfg.pluginDir, entry.name)
    if (looksLikeDshPlugin(entryPath).ok) {
      const pkg = readJson(join(entryPath, 'package.json')) ?? {}
      out.push(localEntry(pkg, entryPath))
      continue
    }
    // 仓库根不是独立插件:本地插件列表仍显示「这个仓库」一行(名称 = 目录名,
    // 插件文件夹里有多少库就显示多少行),再列出可装的子包行。
    out.push({ name: entry.name, version: '', description: '', path: entryPath, isBundle: false, platform: null })
    for (const sub of findPluginSubpackages(entryPath)) {
      const pkg = readJson(join(entryPath, sub.path, 'package.json')) ?? {}
      out.push(localEntry(pkg, join(entryPath, sub.path)))
    }
  }
  return out
}

export function listLocal(home: string, profile: string): LocalPlugin[] {
  const { installed } = listInstalled(home, profile)
  const byName = new Map(installed.map((p) => [p.name, p]))
  return scanLocal().map((p) => {
    const ip = byName.get(p.name)
    // 三态:本地库插件在某实例已安装但未启用 → 'installed';已启用 → 'enabled';未安装 → 'not-installed'。
    return { ...p, status: ip ? (ip.enabled ? 'enabled' : 'installed') : 'not-installed' }
  })
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
      if (p.enabled) {
        (cells[p.name] ??= {})[inst.id] = 'enabled'
      } else if (localNames.has(p.name)) {
        // 本地库插件已安装到该实例但未启用 → 三态中间态「已安装未启用」。
        (cells[p.name] ??= {})[inst.id] = 'installed'
      }
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

/** 安装源是否为 git(GitHub)直装:这类插件优先走 npm 包,网络不行再镜像。 */
function isGitHostedSpec(spec: string): boolean {
  return /^(?:git\+|github:|git@|git:\/\/|https?:\/\/github\.com\/)/i.test(spec.trim())
}

// GitHub 直连拉取失败时的镜像兜底。用 GIT_CONFIG_* 进程级注入 git url 重写
// (url.<base>.insteadOf),不改用户全局 git 配置;pnpm 拉 git 依赖的子进程会继承。
// 镜像可用性动态变化,失败时依次尝试。
const GIT_MIRROR_REWRITES: Array<{ name: string; env: NodeJS.ProcessEnv }> = [
  { name: 'gh-proxy.com', env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.https://gh-proxy.com/https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/' } },
  { name: 'gitclone.com', env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.https://gitclone.com/github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/' } }
]

/** 极简 semver 比较(旧版兜底选版用,不做 prerelease 语义)。 */
function cmpSemver(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

/**
 * 最新版不可得时的旧版兜底:查 npmmirror 上该包可用版本,取「非 latest 的最近一个」重试。
 * 针对镜像同步滞后(latest 已发布但镜像还没就绪)或最新版损坏的情况。
 */
async function installOlderVersion(home: string, profile: string, name: string, flags: string[] | undefined, label: string): Promise<CmdResult | null> {
  try {
    const regName = name.startsWith('@') ? `@${name.slice(1).replace('/', '%2f')}` : name
    const res = await fetch(`https://registry.npmmirror.com/${regName}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const meta = await res.json() as { versions?: Record<string, unknown>; 'dist-tags'?: Record<string, string> }
    const versions = Object.keys(meta.versions ?? {})
    if (versions.length === 0) return null
    const latest = meta['dist-tags']?.latest
    const prev = [...versions].sort((a, b) => cmpSemver(b, a)).find((v) => v !== latest)
    if (!prev) return null
    taskLine(label, t(`最新版不可得,退回上一版本 ${name}@${prev}…`, `latest unavailable; falling back to previous version ${name}@${prev}…`), 'stderr')
    const r = await runPluginCommand(home, profile, ['add', `${name}@${prev}`, ...(flags ?? [])], `${label}:old`)
    return r.ok ? r : null
  } catch {
    return null
  }
}

/**
 * Install a plugin (local path or npm spec) into a profile via `dsh plugin add`
 * and enable it for that profile. With a known `name` we enable explicitly
 * (also self-heals legacy "installed but not enabled" entries); otherwise the
 * newly-added dependency is detected by diffing the manifest and enabled.
 *
 * 安装韧性阶梯(策略:npm 直连优先 → 网络不行走镜像 → 没有新版退旧版):
 * 1) git 源且给了包名时,先试 registry 上的 <name>(国内走 npmmirror,快而稳,
 *    且不用 git —— 顺带让没装 git 的用户也能装上已发 npm 的插件);
 * 2) 原 spec 直装;git 源先确保 git 可用(免装 git 补丁),网络失败时 runPluginCommand
 *    内部依次走 GitHub 镜像重写,镜像不同步的 404 会直连官方 npmjs;
 * 3) 最新版仍不可得时,退回 registry 上可用的上一版本。
 */
export async function install(home: string, profile: string, spec: string, name?: string, flags?: string[]): Promise<CmdResult> {
  if (!spec.trim()) return { ok: false, code: null, error: t('安装源为空。', 'Empty install source.') }
  const target = /^\.{1,2}[/\\]/.test(spec) ? resolve(process.cwd(), spec) : spec
  // 自愈该 profile 的 pnpm 工作区设置(allowBuilds 占位符 / supportedArchitectures),
  // 否则 node-llama-cpp 等原生依赖的跨平台二进制会让整个 profile 的安装失败。
  ensureProfilePnpmSettings(home, profile)
  const before = depNames(home, profile)
  const gitSpec = isGitHostedSpec(spec)
  const label = `install:${target}`

  let r: CmdResult | null = null

  // 1) npm 优先:git 源 + 给了包名 → 先试 registry 上的 <name>。包没发 npm 会 404,
  //    自动落到下面的 git 路径。
  if (gitSpec && name) {
    r = await runPluginCommand(home, profile, ['add', name, ...(flags ?? [])], `install:${name}`)
    if (r.ok) {
      setEnabled(home, profile, name, true)
      return r
    }
  }

  // 2) 原 spec 直装。git 源先确保 git 可用(免装 git 补丁),拿不到 git 就直接报友好错误。
  const gitEnv = gitSpec ? await ensureGitEnvFor(label) : undefined
  if (gitSpec && gitEnv === null) {
    r = { ok: false, code: null, error: t('本机未安装 Git,且自动下载便携版失败。请安装 Git:https://git-scm.com/download/win', 'Git is not installed on this machine and the portable Git download failed. Please install Git: https://git-scm.com/download/win') }
  } else {
    const env: NodeJS.ProcessEnv | undefined = gitEnv ?? undefined
    r = await runPluginCommand(home, profile, ['add', target, ...(flags ?? [])], label, env)
    // pnpm 10 blocks git-hosted packages that run build scripts unless they're
    // in the profile's allowBuilds whitelist. Self-heal: whitelist the package
    // and retry once. Without this, such plugins permanently fail to install.
    if (!r.ok) {
      const blocked = parseAllowBuildsKey(r.stderr)
      if (blocked && allowBuildsWhitelist(home, profile, blocked)) {
        taskLine(label, t(`检测到 pnpm allowBuilds 白名单缺失,已加入 ${blocked} 并重试…`, `Detected missing allowBuilds whitelist entry; added ${blocked} and retrying…`), 'stderr')
        r = await runPluginCommand(home, profile, ['add', target, ...(flags ?? [])], label, env)
      }
    }
  }

  // 3) 最新版仍拿不到 → 旧版兜底(registry 上存在该包、但最新版不可得时)。
  if (!r.ok && name) {
    const old = await installOlderVersion(home, profile, name, flags, label)
    if (old) r = old
  }

  if (r.ok) {
    if (name) {
      setEnabled(home, profile, name, true)
    } else {
      const after = depNames(home, profile)
      for (const n of after) if (!before.has(n)) setEnabled(home, profile, n, true)
    }
  } else {
    // 失败的安装会残留:pnpm 已把依赖写入 package.json、node_modules 留下残缺目录,
    // 且失败的 add 可能已把插件挂进插件树(cordis.patch.yml insert)或 bundles 层
    // (网络失败不像 allowBuilds 那样自动回滚)。若不清理,profile 启动时 include-loader
    // 会尝试导入残缺包而整个 boot 崩溃。这里把本次 spec 新增的残留全部移除。
    rollbackFailedAdd(home, profile, before, spec, name)
  }
  return r
}

/**
 * 从安装 spec 推断可能的包名候选。github 直装可能落成裸名(repo)或 scoped
 * (@owner/repo)两种;本地路径取目录名。
 */
function depNameCandidates(spec: string): string[] {
  let s = spec.trim()
  // 裸 npm 名:@scope/name 或 name。
  const bare = s.match(/^((?:@[^/]+\/)?[^/@\s]+)$/)
  if (bare) return [bare[1]]
  // 去掉 git+/github: 前缀与 #ref、.git 后缀。
  s = s.replace(/^git\+/, '').replace(/^github:/, '')
  s = s.replace(/#.*$/, '').replace(/\.git$/, '')
  // github.com/owner/repo 或 github:owner/repo 或 git+...owner/repo。
  const m = s.match(/github\.com\/([^/]+)\/([^/?#]+)/) ?? s.match(/^([^/]+)\/([^/?#]+)$/)
  if (m) return [m[2], `@${m[1]}/${m[2]}`]
  // 其它 URL(如 codeload/archive)取最后一段。
  const seg = s.match(/\/([^/?#]+)\/?$/)
  return seg ? [seg[1]] : []
}

/**
 * 清理失败安装的残留:package.json dependencies + 残缺的 node_modules 目录 +
 * 插件树 insert(cordis.patch.yml) + dsh.profile.bundles 数组。
 * 只处理「本次新增(不在 before)且包名匹配 spec」的插件,避免误伤并发安装或
 * 原本就存在、只是重装失败的插件(那会破坏一个原本能用的插件)。
 */
function rollbackFailedAdd(home: string, profile: string, before: Set<string>, spec: string, name?: string): void {
  const candidates = new Set<string>([...(name ? [name] : []), ...depNameCandidates(spec)])
  const dir = profileDir(home, profile)
  const file = join(dir, 'package.json')
  const manifest = readJson(file)
  if (!manifest) return
  const deps = (manifest.dependencies as Record<string, string> | undefined) ?? {}
  const dsh = manifest.dsh as Record<string, unknown> | undefined
  const profileBlock = dsh?.profile as Record<string, unknown> | undefined
  const bundles = Array.isArray(profileBlock?.bundles) ? (profileBlock.bundles as string[]) : []
  let changed = false
  for (const n of candidates) {
    if (before.has(n)) continue // 原本就存在:失败的重装不应破坏它
    if (n in deps) {
      delete deps[n]
      changed = true
      taskLine(`install:${spec}`, t(`清理失败安装的残留依赖「${n}」…`, `Cleaning up residual dependency "${n}" from failed install…`), 'stderr')
    }
    // 残缺的 node_modules 目录(含 junction 场景,用 rmSync 兜底)。
    rmSync(join(dir, 'node_modules', n), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    // 插件树 insert:不摘除则启动时 include-loader 仍会导入不存在的包而崩溃。
    if (removePluginInsert(home, profile, n)) changed = true
    // bundles 层:失败 add 若已登记,一并摘除。
    if (bundles.includes(n)) {
      const idx = bundles.indexOf(n)
      bundles.splice(idx, 1)
      changed = true
    }
  }
  if (changed) {
    if (profileBlock) profileBlock.bundles = bundles
    writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8')
  }
}

/**
 * 移除一个「损坏」的插件:package.json 依赖 + node_modules 目录 + 插件树 insert
 * + bundles 数组。用于启动前自愈(healBrokenDeps)与启动失败后的定点清理。
 * 返回是否真的发生了移除。
 */
export function removeBrokenPlugin(home: string, profile: string, name: string): boolean {
  const dir = profileDir(home, profile)
  const file = join(dir, 'package.json')
  const manifest = readJson(file)
  if (!manifest) return false
  const deps = (manifest.dependencies as Record<string, string> | undefined) ?? {}
  const dsh = manifest.dsh as Record<string, unknown> | undefined
  const profileBlock = dsh?.profile as Record<string, unknown> | undefined
  const bundles = Array.isArray(profileBlock?.bundles) ? (profileBlock.bundles as string[]) : []
  let changed = false
  if (name in deps) {
    delete deps[name]
    changed = true
  }
  const bi = bundles.indexOf(name)
  if (bi >= 0) {
    bundles.splice(bi, 1)
    changed = true
  }
  if (changed) {
    manifest.dependencies = deps
    if (profileBlock) profileBlock.bundles = bundles
    writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8')
  }
  rmSync(join(dir, 'node_modules', name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  if (removePluginInsert(home, profile, name)) changed = true
  return changed
}

/**
 * 判断一个已安装的依赖是否「明显损坏」:
 * - node_modules/<name> 缺失或 package.json 不可读 → 损坏(下载失败的残留);
 * - 声明了 main 但文件缺失 → 损坏;
 * - 无 main 且无 dsh 字段 / exports / cordis.patch.yml / index.js 任何入口 → 损坏
 *   (如 git 源码残留没构建出入口)。modlens 这类用 dsh 字段挂载的插件不算损坏。
 */
function isBrokenInstalled(home: string, profile: string, name: string): boolean {
  const pkgDir = join(profileDir(home, profile), 'node_modules', name)
  let pkg: Record<string, unknown> | null
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return true
  }
  const main = typeof pkg.main === 'string' && pkg.main.length > 0 ? pkg.main : null
  if (main) return !existsSync(join(pkgDir, main)) // 声明了 main 但文件缺失
  if (pkg.exports != null || pkg.dsh != null) return false
  return !existsSync(join(pkgDir, 'cordis.patch.yml')) && !existsSync(join(pkgDir, 'index.js'))
}

/**
 * 启动前自愈:扫描 profile 依赖,移除「明显损坏」的插件(残留/未装完/无入口)。
 * 返回被移除的插件名列表。幂等、毫秒级;只动损坏项,不动正常插件。
 */
export function healBrokenDeps(home: string, profile: string): string[] {
  const manifest = readJson(join(profileDir(home, profile), 'package.json'))
  const deps = (manifest?.dependencies as Record<string, string> | undefined) ?? {}
  const removed: string[] = []
  for (const name of Object.keys(deps)) {
    if (!isBrokenInstalled(home, profile, name)) continue
    if (removeBrokenPlugin(home, profile, name)) removed.push(name)
  }
  return removed
}

/**
 * 修复一个 profile 插件树里的「悬空 insert」:cordis.patch.yml 里 insert 了某个
 * 插件,但该包既不在 dependencies 也没有安装到 node_modules(如从本地库删除插件
 * 时卸载失败留下的)。留着会让启动时 include-loader 导入不存在的包而整个 profile
 * 崩溃。返回被移除的悬空插件名。
 */
export function repairProfilePluginRefs(home: string, profile: string): string[] {
  const removed: string[] = []
  const dir = profileDir(home, profile)
  if (!existsSync(join(dir, 'cordis.patch.yml'))) return removed
  const deps = (readJson(join(dir, 'package.json'))?.dependencies as Record<string, string> | undefined) ?? {}
  let patches: unknown[]
  try {
    patches = readProfilePatches(home, profile)
  } catch {
    return removed
  }
  if (!Array.isArray(patches)) return removed
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
      const name = typeof e.name === 'string' ? e.name : (typeof e.id === 'string' ? e.id : null)
      if (!name) return true
      const ok = name in deps && existsSync(join(dir, 'node_modules', name, 'package.json'))
      if (!ok) removed.push(name)
      return ok
    })
    if (kept.length !== insert.length) changed = true
    if (kept.length > 0) next.push({ ...record, insert: kept })
  }
  if (changed) writeProfilePatches(home, profile, next)
  return removed
}

/**
 * 启动时全 profile 健康修复:扫描所有实例的 home,移除各 profile 插件树里的悬空
 * insert(包已不在 deps / node_modules 的)。防止「删了插件但树里还挂着」的引用
 * 在下次启动时让 profile 崩掉。返回修复摘要列表。
 */
export function repairAllProfiles(): string[] {
  const fixed: string[] = []
  const homes = new Set<string>()
  for (const inst of getConfig().instances) {
    try {
      homes.add(instanceDshHome(inst))
    } catch { /* 实例数据异常则跳过该 home */ }
  }
  for (const home of homes) {
    const profilesDir = join(home, 'profiles')
    if (!existsSync(profilesDir)) continue
    for (const p of readdirSync(profilesDir)) {
      if (!existsSync(join(profilesDir, p, 'package.json'))) continue
      for (const n of repairProfilePluginRefs(home, p)) fixed.push(`${p}: ${n}`)
    }
  }
  return fixed
}

/**
 * 判断插件是否被 profile「引用」:在 dependencies、bundles 或插件树 insert
 * (cordis.patch.yml)任一里就算。用于自愈判断——包可能已从 deps 移除但树里还
 * 挂着 insert(如从本地库删除插件时卸载失败),启动仍会加载它而崩溃。
 */
function profileReferencesPlugin(home: string, profile: string, name: string): boolean {
  const manifest = readJson(join(profileDir(home, profile), 'package.json'))
  const deps = (manifest?.dependencies as Record<string, string> | undefined) ?? {}
  if (name in deps) return true
  const dsh = manifest?.dsh as Record<string, unknown> | undefined
  const profileBlock = dsh?.profile as Record<string, unknown> | undefined
  const bundles = Array.isArray(profileBlock?.bundles) ? (profileBlock.bundles as string[]) : []
  if (bundles.includes(name)) return true
  const { names, ids } = patchInsertedPlugins(home, profile)
  return names.has(name) || ids.has(pluginInsertId(name))
}

/**
 * 从 dsh 启动错误里提取「缺失的 profile 插件名」。只认本 profile node_modules
 * 下的包(带路径形式),或裸名但确实被本 profile 引用(deps / bundles / 插件树)
 * 的包——避免把 harness 仓库/其它目录的缺失误判为 profile 插件。
 */
export function missingProfilePlugin(home: string, profile: string, stderr: string): string | null {
  const profileNM = join(home, 'profiles', profile, 'node_modules')
  const profileNMFwd = profileNM.replace(/\\/g, '/')
  const re = /Cannot find package '([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr)) !== null) {
    const target = m[1]
    // 带路径形式:...profiles\<profile>\node_modules\<pkg>\...
    if (target.includes(profileNM) || target.includes(profileNMFwd)) {
      const seg = target.slice(target.lastIndexOf('node_modules') + 'node_modules'.length + 1).split(/[\\/]/)
      return seg[0]?.startsWith('@') && seg[1] ? `${seg[0]}/${seg[1]}` : (seg[0] ?? null)
    }
    // 裸名形式(Cannot find package 'dsh-deep-whale' / '@scope/pkg'):确认真被本
    // profile 引用再返回。scoped 包名(@scope/pkg)含 `/`,不能按「含斜杠=路径」排除。
    const isPlain = !target.includes('\\') && !target.includes('/')
    const isScoped = /^@[^/]+\/[^/]+$/.test(target)
    if ((isPlain || isScoped) && profileReferencesPlugin(home, profile, target)) return target
  }
  return null
}

export async function remove(home: string, profile: string, name: string): Promise<CmdResult> {
  return runPluginCommand(home, profile, ['remove', name], `remove:${name}`)
}

/** Uninstall a plugin from a profile: drop it from bundles first, then the dependency. */
export async function disable(home: string, profile: string, name: string): Promise<CmdResult> {
  // 停用 = 只移除挂载(本地源码 / 直装包仍在),不卸载依赖——卸载慢、易卡,
  // 且本地持有插件源码就在本地,重新启用直接 setEnabled(true) 即可,无需重装。
  setEnabled(home, profile, name, false)
  return { ok: true, code: 0 }
}

/** 从某个实例卸载依赖(「已安装未启用」的卸载):移除挂载并删除该实例的依赖。 */
export async function uninstall(home: string, profile: string, name: string): Promise<CmdResult> {
  setEnabled(home, profile, name, false)
  return remove(home, profile, name)
}

/** 启用一个已安装但未启用的插件(不重新安装):按 bundle/insert 通道加回挂载。 */
export async function enable(home: string, profile: string, name: string): Promise<CmdResult> {
  setEnabled(home, profile, name, true)
  return { ok: true, code: 0 }
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
        const pull = await runAsync(git.exe, ['-C', localPath, 'pull', '--ff-only'], process.cwd(), label, false, gitEnvFor(git.exe), GIT_TIMEOUT_MS)
        if (!pull.ok) taskLine(label, t('[update] 拉取失败，继续重装现有代码。', '[update] Pull failed; reinstalling existing code.'), 'stderr')
      }
    }
    return install(home, profile, localPath)
  }

  const { cmd, args, cwd, envPatch } = dshPluginCmd(home, profile, ['up', name])
  return runAsync(cmd, args, cwd, label, process.platform === 'win32', envPatch)
}

/** 向上找到含 .git 的仓库根目录(多插件仓库 = 一个目录 + 多个子包)。 */
function repoRootOf(path: string): string | null {
  let cur = path
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

/**
 * 本地持有插件的「更新」:先给全部实例卸载该插件(释放源码目录占用),再从 GitHub
 * 拉取最新源码,最后重装回之前装了它的实例。
 *
 * 一个 GitHub 仓库常带多个插件(monorepo / 子目录):更新时按「仓库」整体处理——
 * 找到仓库根(.git),收集仓库内所有插件,一起卸载 → git pull 一次更新全部 → 一起重装。
 * 进度走 taskLine/taskProgress;GitHub 连不上给出清晰提示。
 */
export async function updateLocalPlugin(localPath: string): Promise<CmdResult> {
  const cfg = getConfig()
  const label = `update-local:${basename(localPath)}`
  // 1. 找到仓库根(含 .git)。
  const repo = repoRootOf(localPath)
  if (!repo || !existsSync(join(repo, '.git'))) {
    return { ok: false, code: 1, error: t('未找到该插件的 git 仓库,无法更新', 'No git repo found for this plugin; cannot update') }
  }
  // 2. 收集仓库内所有插件:仓库根是插件 → 一个;否则是多个子包。
  const packages: Array<{ name: string; path: string }> = []
  if (looksLikeDshPlugin(repo).ok) {
    const pkg = readJson(join(repo, 'package.json'))
    if (pkg && typeof pkg.name === 'string') packages.push({ name: pkg.name, path: repo })
  }
  for (const sub of findPluginSubpackages(repo)) {
    packages.push({ name: sub.name, path: join(repo, sub.path) })
  }
  if (packages.length === 0) {
    return { ok: false, code: 1, error: t('仓库里没找到可更新的 dsh 插件', 'No dsh plugins found in this repo') }
  }
  taskLine(label, t(`[update] 更新仓库 ${basename(repo)}(含 ${packages.length} 个插件)…`, `[update] Updating repo ${basename(repo)} (${packages.length} plugin(s))…`))
  // 3. 卸载全部实例中的所有相关插件(先停用再移除)。
  taskProgress(label, 0.1, t('卸载实例中的插件…', 'Uninstalling from instances…'))
  const affectedByPkg = new Map<string, string[]>()
  for (const pkg of packages) {
    const ids: string[] = []
    for (const inst of cfg.instances) {
      const home = instanceDshHome(inst)
      const { installed } = listInstalled(home, inst.profile)
      if (!installed.some((x) => x.name === pkg.name)) continue
      setEnabled(home, inst.profile, pkg.name, false)
      await remove(home, inst.profile, pkg.name)
      ids.push(inst.id)
    }
    if (ids.length) affectedByPkg.set(pkg.name, ids)
  }
  // 4. git pull(GitHub 连不上给清晰提示)。
  taskProgress(label, 0.4, t('从 GitHub 拉取最新…', 'Pulling latest from GitHub…'))
  const git = await ensureGit(label)
  if (!git.ok) { taskDone(label, 1); return { ok: false, code: 1, error: git.error } }
  const pull = await runAsync(git.exe, ['-C', repo, 'pull', '--ff-only'], process.cwd(), label, false, gitEnvFor(git.exe), GIT_TIMEOUT_MS)
  if (!pull.ok) {
    taskDone(label, pull.code ?? 1)
    const stderr = pull.stderr ?? ''
    const friendly = /could not resolve|failed to connect|unable to access|not authorized|fatal:/i.test(stderr)
      ? t(`无法连接 GitHub 仓库(网络或权限问题):${stderr.split('\n')[0]}`, `Cannot reach the GitHub repo (network or auth): ${stderr.split('\n')[0]}`)
      : (pull.error ?? t('拉取失败', 'Pull failed'))
    taskLine(label, `[update] ${friendly}`, 'stderr')
    return { ok: false, code: pull.code ?? 1, error: friendly }
  }
  // 5. 重装回之前装了它们的实例(仓库内所有插件一起)。
  taskProgress(label, 0.8, t('重新安装到实例…', 'Reinstalling to instances…'))
  const affected = new Set<string>()
  for (const pkg of packages) {
    for (const id of affectedByPkg.get(pkg.name) ?? []) {
      const inst = cfg.instances.find((x) => x.id === id)
      if (!inst) continue
      const home = instanceDshHome(inst)
      await install(home, inst.profile, pkg.path, pkg.name)
      affected.add(id)
    }
  }
  taskProgress(label, 1, t('更新完成', 'Update complete'))
  taskLine(label, t(`[update] ✔ 更新完成: ${basename(repo)}`, `[update] ✔ Done: ${basename(repo)}`))
  taskDone(label, 0)
  return { ok: true, code: 0, affected: [...affected] }
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
  // 统一改名名(固定,不带时间戳):避免反复改名时 `.deleting-` 后缀叠加累积成
  // `.deleting-….deleting-….deleting-…` 一串(用户实际遇到过的残留)。
  const base = basename(dir)
  const trash = base.startsWith('.deleting-')
    ? join(dirname(dir), `.deleting-${process.pid}`)
    : `${dir}.deleting-${process.pid}`
  try {
    renameSync(dir, trash)
    rmSync(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    // 改名成功 = 原路径已从本地库消失,视为移除成功;清残余失败不阻塞,交给
    // cleanupDeletingResidue 下次清理。只有「改名本身失败」(目录仍被打开)才是真占用。
    if (existsSync(dir)) {
      throw new Error(t(
        `目录被占用,无法删除 ${dir}。若插件正被运行中的实例加载,请先停止该实例再移除。`,
        `Directory is locked and could not be removed: ${dir}. If the plugin is loaded by a running instance, stop it first.`
      ))
    }
  }
}

/**
 * 删除前等文件句柄释放:反复尝试删除目录,成功即返回 true;超过重试仍被占用返回
 * false(由调用方走改名兜底 + 延时清理)。实例刚停时句柄常在 1-2s 后才释放,之前
 * 只等 400ms 就删、失败直接改名,于是留下 `.deleting-` 残留。这里把等待窗口拉长,
 * 多数锁释放后能直接删干净,不再产生残留。
 */
async function waitUntilDeletable(dir: string, attempts = 15, delayMs = 400): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      removeLinksInside(dir)
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      return true
    } catch {
      if (i < attempts - 1) await delay(delayMs)
    }
  }
  return false
}

/**
 * Remove a plugin from the local library entirely: uninstall it from every
 * instance's profile (so no `file:` dependency dangles into a deleted folder),
 * then delete its source from pluginDir. Returns the affected instance ids so
 * the caller can restart the running ones.
 */
/**
 * 清理命令行中涉及 `dir` 的残留 node/dsh/electron 进程。实例已停止但可能残留孤儿
 * 子进程(如 dsh 派生的插件进程)仍持有本地库文件句柄,导致删除 EPERM。幂等:只杀
 * 匹配进程,其余不动。仅 Windows。
 */
function killResidualProcesses(dir: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  return new Promise((resolve) => {
    // 清掉可能持有插件文件句柄的 node/dsh/electron 进程:命令行含该目录、或含该
    // 目录名(插件派生的子进程/孤儿进程 cwd 常落在插件目录,命令行未必含完整路径)。
    // 只 kill 匹配进程,其余不动;幂等。
    const base = basename(dir)
    const ps = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `$d='${dir}'; $b='${base}'; ` +
        `Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'node|dsh|electron') -and ($_.CommandLine -like "*$d*" -or $_.CommandLine -like "*$b*") } | ` +
        `ForEach-Object { taskkill /F /T /PID $($_.ProcessId) }`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    ps.on('close', () => resolve())
    ps.on('error', () => resolve())
  })
}

/**
 * 删除插件目录:每轮先强制释放占用(kill 持有句柄的进程)→ 等句柄释放 → force 删,
 * 然后验证目录是否真的消失。整体最多 3 轮(初始 + 2 次重试),仍残留返回 false。
 * 首轮等待窗口最长(多数锁 1-2s 释放),重试轮缩短,避免整体耗时过长「卡住」。
 */
async function deletePluginDirWithRetry(dir: string): Promise<boolean> {
  for (let round = 0; round < 3; round++) {
    if (!existsSync(dir)) return true
    await killResidualProcesses(dir)
    const deleted = await waitUntilDeletable(dir, round === 0 ? 15 : 5, 400)
    if (!deleted) {
      try { removeDirForce(dir) } catch { /* 已尽力;下一轮或返回残留 */ }
    }
    if (!existsSync(dir)) return true
    if (round < 2) await delay(700)
  }
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 本地库是否还有 `.deleting-` 残留。 */
function hasDeletingResidue(): boolean {
  const pluginDir = getConfig().pluginDir
  if (!pluginDir || !existsSync(pluginDir)) return false
  try {
    return readdirSync(pluginDir).some((n) => n.startsWith('.deleting-'))
  } catch {
    return false
  }
}

/** 清理本地库下删除改名兜底遗留的 `.deleting-*` 残留(未被占用的直接删,防累积)。 */
function cleanupDeletingResidue(): void {
  const pluginDir = getConfig().pluginDir
  if (!pluginDir || !existsSync(pluginDir)) return
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.deleting-')) continue
    try {
      rmSync(join(pluginDir, entry.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
    } catch {
      /* 仍被占用,留待下次清理 */
    }
  }
}

/**
 * 删除改名兜底留下的 `.deleting-` 残留,稍后异步多轮重试。
 * 删除时实例刚被停止,残留句柄可能在 1-2s 后才释放;扫描清理只跑一次,若当时还没
 * 释放就永远清不掉。这里在删除后补上延时多轮清理,句柄一释放就自动清掉残留。
 */
async function cleanupDeletingResidueSoon(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await delay(1500)
    cleanupDeletingResidue()
    if (!hasDeletingResidue()) return
  }
}

export async function removeFromLibrary(name: string): Promise<CmdResult> {
  const cfg = getConfig()
  // 先清理历史上删除改名兜底遗留的 `.deleting-*` 残留(未被占用的直接删)。
  cleanupDeletingResidue()
  const entry = scanLocal().find((p) => p.name === name)
  // 完整性检定(仅在删除时触发):
  // - entry 存在(scanLocal 认得它)= 完整插件 → 正常删除。
  // - 目录仍在但 scanLocal 不认(部分移除/损坏,如 package.json 已丢)= 视为
  //   残余,自动清掉,避免它一直显示在本地库或占用名字。
  // - 目录已整体消失(此前已移除)= 按移除成功处理,不再报「找不到」。
  const dir = entry?.path ?? join(cfg.pluginDir, name)
  const dirExists = existsSync(dir)

  const affected: string[] = []
  for (const inst of cfg.instances) {
    const home = instanceDshHome(inst)
    const { installed } = listInstalled(home, inst.profile)
    if (!installed.some((p) => p.name === name)) continue
    setEnabled(home, inst.profile, name, false)
    const r = await remove(home, inst.profile, name)
    if (r.ok) {
      affected.push(inst.id)
    } else {
      // `dsh plugin remove` 失败(实例未停 / 依赖损坏 / 网络):至少把该 profile 里
      // 对它的引用(deps + bundles + 插件树 insert)清掉,避免本地库删了之后启动
      // 时 include-loader 还去加载一个已不存在的插件而整个 profile 崩掉。
      removeBrokenPlugin(home, inst.profile, name)
    }
  }

  if (dirExists) {
    // 删除前强制释放占用(kill 持有句柄的残留进程)→ 等待句柄释放 → 验证目录真的消失。
    // 整体最多重试 3 轮(初始 + 2 次);仍失败则返回残留状态,由渲染端弹提示让用户手动
    // 删除,不无限重试、不卡住。
    const deleted = await deletePluginDirWithRetry(dir)
    // 兜底:即使走了改名仍留了 `.deleting-`,后台多轮延时清理会在句柄释放后自动清掉。
    void cleanupDeletingResidueSoon()
    if (!deleted) {
      return {
        ok: false,
        code: 1,
        error: t(
          `未能删除插件文件夹: ${dir}\n可能仍被进程占用。请停止相关实例后,手动删除该文件夹。`,
          `Could not delete plugin folder: ${dir}\nIt may still be locked by a process. Stop the related instance and delete the folder manually.`
        ),
        affected
      }
    }
  }
  // 插件已从本地库移除(或本就已移除),连同它的显示名/备注一并清掉,
  // 避免「插件删了、名字还留在上面」的残留(此前推荐整合包功能遗留过这个问题)。
  if (cfg.pluginMeta?.[name]) setPluginMeta(name, { displayName: '', remark: '' })
  return { ok: true, code: 0, affected }
}

/** 批量删除本地插件(插件页勾选后一次移除):逐个 removeFromLibrary,汇总受影响的实例与失败项。 */
export async function removeFromLibraryMany(names: string[]): Promise<CmdResult> {
  const affected: string[] = []
  const warnings: string[] = []
  const label = 'remove-many'
  const total = Math.max(names.length, 1)
  taskProgress(label, 0, t('开始删除…', 'Starting removal…'))
  let done = 0
  for (const name of names) {
    try {
      done += 1
      taskProgress(label, done / total, t(`正在删除 ${name} (${done}/${total})…`, `Removing ${name} (${done}/${total})…`))
      const r = await removeFromLibrary(name)
      for (const id of r.affected ?? []) if (!affected.includes(id)) affected.push(id)
      if (!r.ok) warnings.push(t(`「${name}」移除失败: ${r.error ?? ''}`, `"${name}" removal failed: ${r.error ?? ''}`))
    } catch (e) {
      warnings.push(t(`「${name}」移除出错: ${String(e)}`, `"${name}" removal error: ${String(e)}`))
    }
  }
  taskDone(label, 0)
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

/** 整合包清单校验(对齐 dsh-plugin-pack schema 的基本约束)。返回问题列表(空 = 合法)。 */
function validateBundle(bundle: RecommendedBundle): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const p of bundle.community) {
    const id = p.id ?? p.name
    if (!id) { errors.push(t('整合包内有插件缺少 id/name', 'A bundle plugin is missing id/name')); continue }
    if (ids.has(id)) errors.push(t(`插件 id 重复: ${id}`, `Duplicate plugin id: ${id}`))
    ids.add(id)
    if (p.kind !== undefined && p.kind !== 'plugin' && p.kind !== 'extension') {
      errors.push(t(`插件 ${id} 的 kind 非法: ${p.kind}`, `Invalid kind for plugin ${id}: ${p.kind}`))
    }
    if (!p.spec && !p.name) errors.push(t(`插件 ${id} 缺少 spec`, `Plugin ${id} is missing spec`))
    for (const r of p.requires ?? []) {
      if (r !== id && !bundle.community.some((o) => (o.id ?? o.name) === r)) {
        errors.push(t(`插件 ${id} requires 的宿主不在本整合包: ${r}`, `Plugin ${id} requires a host not in this pack: ${r}`))
      }
    }
  }
  return errors
}

/** 在线整合包市场索引(dsh-plugin-pack 规范的市场收录文件)。 */
const MARKET_INDEX_URL = 'https://raw.githubusercontent.com/baihejiangnan/dsh-plugin-pack/main/market/index.json'
/** 拉取结果缓存,避免每次安装都请求网络。 */
let remoteBundlesCache: RecommendedBundle[] | null = null
/** 是否成功连上在线整合包库(UI 据此显示「已连接 Pack 整合包库」)。 */
let packConnected = false

/** 把 raw.githubusercontent 地址转为 jsdelivr CDN(国内可访问;raw 常被墙)。 */
function toCdn(url: string): string {
  const m = /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/.exec(url)
  if (!m) return url
  return `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`
}

/**
 * 拉取在线整合包清单(全部整合包由 dsh-plugin-pack 市场提供):market/index.json 列出
 * 各 pack,逐个拉取其 dsh-plugin-pack.json 并转换为 RecommendedBundle。网络失败回退内置。
 * 返回 bundles(远程在前 + 内置兜底)与 connected(是否成功连上在线库)。
 */
export async function fetchRemoteBundles(): Promise<{ bundles: RecommendedBundle[]; connected: boolean }> {
  if (remoteBundlesCache !== null) {
    return { bundles: packConnected ? remoteBundlesCache : RECOMMENDED_BUNDLES, connected: packConnected }
  }
  remoteBundlesCache = []
  packConnected = false
  try {
    const indexRes = await fetch(toCdn(MARKET_INDEX_URL), { signal: AbortSignal.timeout(8000) })
    if (!indexRes.ok) throw new Error(`index HTTP ${indexRes.status}`)
    const index = (await indexRes.json()) as { packs?: { id?: string; name?: string; description?: string; sourceUrl?: string; profile?: string }[] }
    for (const pack of index.packs ?? []) {
      if (!pack.sourceUrl) continue
      const res = await fetch(toCdn(pack.sourceUrl), { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const m = (await res.json()) as {
        schemaVersion?: number; id?: string; name?: string; version?: string; description?: string; license?: string
        plugins?: Array<{ id?: string; name?: string; kind?: 'plugin' | 'extension'; requires?: string[]; spec?: string; repository?: string; description?: string }>
      }
      const community = (m.plugins ?? []).map((pl) => ({
        id: pl.id, name: pl.name, kind: pl.kind, requires: pl.requires,
        spec: pl.spec, repository: pl.repository, description: pl.description
      }))
      if (community.length === 0) continue
      remoteBundlesCache.push({
        schemaVersion: m.schemaVersion ?? 1,
        id: m.id ?? pack.id ?? '',
        name: m.name ?? pack.name ?? '',
        version: m.version,
        description: m.description ?? pack.description ?? '',
        license: m.license,
        community
      })
      packConnected = true
    }
  } catch {
    remoteBundlesCache = [] // 网络失败 → 只用内置
  }
  // 连接成功:整合包完全由在线库提供(不含内置);离线/失败:回退内置。
  return { bundles: packConnected ? remoteBundlesCache : RECOMMENDED_BUNDLES, connected: packConnected }
}

export async function installBundle(
  bundleId: string,
  options?: { retrySpecs?: string[]; homeMode?: 'shared' | 'isolated'; home?: string },
): Promise<CmdResult> {
  const bundles = (await fetchRemoteBundles()).bundles
  const bundle = bundles.find((b) => b.id === bundleId)
  if (!bundle) return { ok: false, code: null, error: t('未找到整合包。', 'Bundle not found.') }
  const warnings: string[] = []
  const failedSpecs: string[] = []
  // 清单校验(阶段 4):不合法的问题作为警告列出,不阻断安装(宽松)。
  warnings.push(...validateBundle(bundle))
  const retrySpecs = options?.retrySpecs
  // 重试模式(传入了上次失败的 spec 清单):跳过建实例与 profile 修复,只对清单里的插件重新直装。
  const retry = Array.isArray(retrySpecs) && retrySpecs.length > 0
  const community: BundlePlugin[] = retry
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
    // requires 依赖顺序(阶段 3):先装 plugin 宿主,再装 extension 扩展。
    const ordered = [...community].sort((a, b) => {
      const ae = (a.kind === 'extension' ? 1 : 0)
      const be = (b.kind === 'extension' ? 1 : 0)
      return ae - be
    })
    let n = 0
    for (const p of ordered) {
      const spec = p.spec || p.name
      if (!spec) continue
      n += 1
      const phase = t(`安装社区插件 ${n}/${community.length}:${p.name ?? spec}…`, `Installing community plugin ${n}/${community.length}: ${p.name ?? spec}…`)
      report(phase)
      const r = await install(home, profile, spec, p.name, p.flags)
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

/**
 * 为 `dsh plugin add` 的 pnpm→git 子进程准备环境:先确保 git 可用(免装 git 补丁:
 * 系统 git 缺失时自动下载便携版 MinGit),返回带 PATH 注入的环境。返回 null 表示既没有
 * 系统 git 便携版也没下载成功 —— 调用方应给出友好错误而不是让 pnpm 报「git not found」。
 */
async function ensureGitEnvFor(label: string): Promise<NodeJS.ProcessEnv | null> {
  const git = await ensureGit(label)
  if (!git.ok) return null
  return gitEnvFor(git.exe)
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
function findPluginSubpackages(target: string, depth = 0): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = []
  if (depth > 5) return out
  let entries: string[]
  try {
    entries = readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git')
      .map((e) => e.name)
  } catch {
    return out
  }
  for (const name of entries) {
    const dir = join(target, name)
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg && typeof pkg.name === 'string' && pkg.dsh && typeof pkg.dsh === 'object') {
      out.push({ path: name, name: pkg.name })
    } else {
      // 递归更深层(packages/xxx 等多层 monorepo),最多 5 层,路径用 / 连接。
      for (const sub of findPluginSubpackages(dir, depth + 1)) {
        out.push({ path: `${name}/${sub.path}`, name: sub.name })
      }
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
    const pull = await runAsync(git.exe, ['-C', target, 'pull', '--ff-only'], process.cwd(), label, false, gitEnv, GIT_TIMEOUT_MS)
    if (!pull.ok) taskLine(label, t('[download] 拉取未完成(可能有本地改动),继续使用现有代码。', '[download] Pull incomplete (possible local changes); using existing code.'), 'stderr')
  } else if (existsSync(target) && readdirSync(target).length > 0) {
    taskLine(label, t('[download] 目标目录非空且非 git 仓库,跳过克隆,仅安装依赖。', '[download] Target dir is non-empty and not a git repo; skipping clone, installing deps only.'), 'stderr')
    taskDone(label, 0)
  } else {
    const clone = await runAsync(git.exe, cloneArgs(authedCloneUrl(url, cfg.githubToken), target), process.cwd(), label, false, gitEnv, GIT_TIMEOUT_MS, cfg.githubToken)
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
    const pull = await runAsync(git.exe, ['-C', target, 'pull', '--ff-only'], process.cwd(), label, false, gitEnv, GIT_TIMEOUT_MS)
    if (!pull.ok) taskLine(label, t('[download] 拉取未完成,使用现有代码。', '[download] Pull incomplete; using existing code.'), 'stderr')
  } else {
    const clone = await runAsync(git.exe, cloneArgs(authedCloneUrl(gh.cloneUrl, cfg.githubToken), target, gh.ref), process.cwd(), label, false, gitEnv, GIT_TIMEOUT_MS, cfg.githubToken)
    if (!clone.ok) {
      // Wipe the partial clone (may only contain `.git`) so a retry starts fresh.
      rmSync(target, { recursive: true, force: true })
      taskDone(label, clone.code ?? 1)
      return clone
    }
  }

  // 下载 = 克隆整个仓库到本地库。插件定位/选择交由「插件」页(矩阵,scanLocal 会
  // 列出仓库根与所有子包),这里不做单个包判定——克隆成功即下载成功。
  taskLine(label, t(`[download] 已下载到本地库: ${target} — 可在「插件」页启用。`, `[download] Downloaded to the local library: ${target} — enable it from the Plugins page.`))
  taskDone(label, 0)
  return { ok: true, code: 0 }
}
