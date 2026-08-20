// DSH instance manager: the multi-instance data model lives on
// LauncherConfig.instances (each instance = its own profile, port, and session
// workspace); this module is the read/write surface and the session-isolation
// helpers. The spawned processes themselves are managed by harness.ts.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfig, setConfig } from './config'
import type { DshInstance, LauncherConfig, NewInstanceInput } from '../shared/types'

// --- profile creation ---
//
// dsh boots a profile by composing the patch layers listed in its manifest
// (`$DSH_HOME/profiles/<name>/package.json` → `dsh.profile.bundles`). Unlike
// `dsh plugin --profile …`, the *boot* path does NOT auto-init an unknown
// profile name — it fails with "profile does not exist". So each new instance
// must get its own profile directory physically created up front, initialized
// to the shipped template. That is what makes instances' plugin sets
// non-shared: sharing one profile across instances would share its manifest
// edits (enabled/installed plugins) between them.

/** Shipped profile templates, mirrored from dsh's `PROFILE_TEMPLATES`. */
const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
}

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  node-llama-cpp: true
  node-pty: true
supportedArchitectures:
  os:
    - ${process.platform}
  cpu:
    - ${process.arch}
`

/** `<home>/profiles/<name>` — a profile is a directory holding a manifest. */
function profileDir(home: string, profile: string): string {
  return join(home, 'profiles', profile)
}

/**
 * 剥离 UTF-8 BOM(U+FEFF):Windows 记事本等外部工具改写 package.json 时会写入 BOM,
 * 而 dsh 内核 `JSON.parse` 不认 BOM,启动直接报
 * `SyntaxError: Unexpected token '\uFEFF'`。启动前调用,带 BOM 则重写为无 BOM。
 * @param file - 目标 JSON 文件(通常是 profile 的 package.json)。
 * @returns 是否实际发生了剥离(文件存在且开头有 BOM 且重写成功)。
 */
export function stripBomIfPresent(file: string): boolean {
  if (!existsSync(file)) return false
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  if (!raw.startsWith('\uFEFF')) return false
  try {
    writeFileSync(file, raw.slice(1), 'utf8')
  } catch {
    return false
  }
  return true
}

/**
 * 实例的 DSH_HOME:独立 home(inst.dshHome)或共享 cfg.dshHome。纯解析,不校验
 * 存在性——缺失时启动路径显式报错(harness.ts),创建路径负责 mkdir。
 */
export function instanceDshHome(inst: DshInstance): string {
  return inst.dshHome ?? getConfig().dshHome
}

/** 确保实例 home 物理存在(写操作兜底用);启动路径不用它,以免掩盖缺失的独立 home。 */
export function ensureInstanceHome(inst: DshInstance): string {
  const home = instanceDshHome(inst)
  try {
    mkdirSync(home, { recursive: true })
  } catch {
    /* ignore — 后续操作会失败出声 */
  }
  return home
}

/** The shipped bundle list for a base profile name (falls back to the web template). */
function templateBundles(base: string): string[] {
  return [...(PROFILE_TEMPLATES[base] ?? PROFILE_TEMPLATES.web)]
}

/**
 * A profile name is also the CLI's profile flag value, so it must match what
 * dsh accepts: no separators, `.`, `..`, or the reserved `node_modules`
 * fallback. Anything the user typed that can't be a name falls back to `web`.
 */
function sanitizeProfileBase(raw: string): string {
  const base = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!base || base === 'node_modules' || base === '.' || base === '..') return 'web'
  return base
}

/**
 * Pick a profile name that does not exist on disk yet, starting from `web`,
 * `web-2`, `web-3`, … (the base itself is taken by the shared/default profile).
 * 唯一性域按 home:独立 home 从空开始,base 名直接可用,即使共享 home 已有同名。
 */
function uniqueProfileName(base: string, home: string): string {
  let name = base
  for (let n = 2; existsSync(profileDir(home, name)); n++) name = `${base}-${n}`
  return name
}

/**
 * Physically create a profile directory (manifest, empty user patch layer, and
 * pnpm settings), mirroring dsh's `initProfile` exactly. Existing files are
 * never touched, so re-running is a no-op on an initialized profile.
 */
function createProfile(home: string, profile: string, bundles: string[]): void {
  const dir = profileDir(home, profile)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest = { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles } } }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}

/** Ensure an arbitrary profile name is bootable: sanitize + create if missing (in the given home). */
export function ensureProfile(name: string, home: string): string {
  const clean = sanitizeProfileBase(name)
  if (!existsSync(profileDir(home, clean))) createProfile(home, clean, templateBundles(clean))
  return clean
}

// --- reads ---

export function getInstances(): DshInstance[] {
  return getConfig().instances
}

export function getInstance(id: string): DshInstance | undefined {
  return getConfig().instances.find(i => i.id === id)
}

export function getActiveInstance(): DshInstance {
  const cfg = getConfig()
  return (
    cfg.instances.find(i => i.id === cfg.activeInstanceId && i.enabled !== false) ??
    cfg.instances.find(i => i.enabled !== false) ??
    cfg.instances[0]
  )
}

/**
 * The process working directory for an instance. Instances created before the
 * multi-instance feature (and the migrated default) leave `workspace` unset and
 * keep the historical cwd — harness repo in source mode, runtime root in
 * bundled mode — so existing sessions stay put. New instances get their own
 * folder under `runtimeRoot/workspaces/<id>` for true session isolation.
 */
export function resolveWorkspace(inst: DshInstance): string {
  if (inst.workspace) return inst.workspace
  const cfg = getConfig()
  return cfg.installMode === 'bundled' ? cfg.runtimeRoot : cfg.harnessRepo
}

/** resolveWorkspace + ensure it physically exists before spawning into it. */
export function ensureWorkspace(inst: DshInstance): string {
  const ws = resolveWorkspace(inst)
  try {
    mkdirSync(ws, { recursive: true })
  } catch {
    /* ignore — spawn will fail loudly if the cwd is unusable */
  }
  return ws
}

/**
 * Directory where dsh stores this instance's session list. Sessions are grouped
 * under `<dshHome>/sessions/<projectKey(cwd)>` (see dsh's session-persistence
 * plugin), which is exactly why a per-instance cwd isolates conversations.
 */
export function sessionsDir(inst: DshInstance): string {
  return join(instanceDshHome(inst), 'sessions', projectKey(resolveWorkspace(inst)))
}

/**
 * The human-navigable project key dsh derives from a cwd — the session folder
 * name under `<dshHome>/sessions/`. Replicated 1:1 from dsh's
 * `session-persistence-jsonl` `projectKey()`: `/ \ :` become a single `-`,
 * unsafe code units use the `~XXXX` escape, the result is bounded and wrapped
 * in `--…--`. Getting this wrong silently breaks session import, so it mirrors
 * the source exactly.
 */
export function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** True when the instance has any stored session data on disk. */
export function hasSessions(inst: DshInstance): boolean {
  return existsSync(sessionsDir(inst))
}

// --- mutations ---

/** Switch the UI's active instance (mirrors in config follow automatically). */
export function setActiveInstance(id: string): LauncherConfig {
  const cfg = getConfig()
  if (!cfg.instances.some(i => i.id === id)) return cfg
  return setConfig({ activeInstanceId: id })
}

function defaultName(cfg: LauncherConfig): string {
  return `${cfg.language === 'en' ? 'Instance' : '实例'} ${cfg.instances.length + 1}`
}

/** 独立 home 创建时复制共享 home 的 .credentials.yaml(API Key)。源缺失静默跳过、目标已存在不覆盖、失败仅警告。 */
function copyCredentialsIfAny(home: string): void {
  const src = join(getConfig().dshHome, '.credentials.yaml')
  const dst = join(home, '.credentials.yaml')
  try {
    if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst)
  } catch (err) {
    console.warn('[launcher] 复制 .credentials.yaml 到独立 home 失败:', err)
  }
}

/**
 * Create a new instance with its own workspace (session isolation) AND its own
 * profile: a unique auto-named profile (`web-2`, `web-3`, …) is physically
 * created so the instance boots without dsh's "profile does not exist" error,
 * and nothing is shared with other instances' plugin sets. `homeMode: 'isolated'`
 * gives the instance a brand-new DSH_HOME under `runtimeRoot/homes/<id>` (nothing
 * is shared with any other instance; the chosen home's API key is copied over).
 * `homeMode: 'shared'`(缺省)共享到 `input.home` 指定的已有 home(可为任一实例的
 * 独立 home,也可为全局 cfg.dshHome)——新实例的 profile 建在目标 home 下。
 * Returns the new config with the fresh instance made active.
 */
export async function addInstance(input: NewInstanceInput): Promise<LauncherConfig> {
  const cfg = getConfig()
  const id = randomUUID()
  const isolated = input.homeMode === 'isolated'
  const home = isolated ? join(cfg.runtimeRoot, 'homes', id) : (input.home?.trim() || cfg.dshHome)
  if (isolated) {
    // config.ts 的 firstExisting 语义要求 home 必须已存在才被接受
    mkdirSync(home, { recursive: true })
    copyCredentialsIfAny(home)
  }
  const base = sanitizeProfileBase((input.profile || '').trim() || cfg.profile || 'web')
  const profile = uniqueProfileName(base, home)
  // 端口冲突兜底:指定端口若与其他实例重复,自动向上找空闲端口(语义同端口 0 的
  // 「自动」),避免后启动者报「端口被占用」或把对方误判为外部实例。
  let port = Number.isFinite(input.port) && input.port > 0 ? input.port : 0
  if (port > 0) {
    const taken = new Set(cfg.instances.map(i => i.port).filter(p => p > 0))
    while (taken.has(port)) port++
  }
  createProfile(home, profile, templateBundles(base))
  const inst: DshInstance = {
    id,
    name: (input.name || '').trim() || defaultName(cfg),
    profile,
    port,
    autoStart: Boolean(input.autoStart),
    description: (input.description ?? '').trim(),
    enabled: true,
    workspace: join(cfg.runtimeRoot, 'workspaces', id),
    ...(isolated ? { dshHome: home } : {})
  }
  setConfig({ instances: [...cfg.instances, inst] })
  return setActiveInstance(id)
}

/**
 * Rename / re-profile / re-port / toggle autoStart of an instance. A
 * hand-typed profile is sanitized, and a name that doesn't exist on disk is
 * created on the spot — otherwise the instance would fail to boot with dsh's
 * "profile does not exist" error.
 */
export function updateInstance(id: string, patch: Partial<Omit<DshInstance, 'id'>>): LauncherConfig {
  const cfg = getConfig()
  if (!cfg.instances.some(i => i.id === id)) return cfg
  // dshHome 是创建期属性:禁止后续修改,否则与磁盘实际位置脱节
  const { dshHome: _ignored, ...rest } = patch
  const instances = cfg.instances.map(i => {
    if (i.id !== id) return i
    const next = { ...i, ...rest }
    if (next.profile) next.profile = ensureProfile(next.profile, instanceDshHome(next))
    return next
  })
  return setConfig({ instances })
}

/**
 * Delete an instance: removes ONLY the config entry — on-disk data (profile
 * directory, workspace, isolated home) is deliberately LEFT in place.
 * 2026-08-19 用户决策:真删盘曾经让人怀疑误删了东西,删除改为只改配置,
 * 磁盘垃圾保留(如确定不要,用户可自行手动清理 profile / homes 目录)。
 * Refuses when it is the last one.
 */
export async function removeInstance(id: string): Promise<LauncherConfig> {
  const cfg = getConfig()
  if (cfg.instances.length <= 1) return cfg
  if (!cfg.instances.some(i => i.id === id)) return cfg
  const instances = cfg.instances.filter(i => i.id !== id)
  const activeInstanceId =
    cfg.activeInstanceId === id
      ? (instances.find(i => i.enabled !== false) ?? instances[0]).id
      : cfg.activeInstanceId
  return setConfig({ instances, activeInstanceId })
}

