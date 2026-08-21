// Per-instance dsh lifecycle: one spawn per DshInstance (own profile, port,
// session workspace), all sharing the same runtime and DSH_HOME. Instances run
// in parallel; each has its own state/log, port probe, and external monitor.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createConnection } from 'node:net'
import { getConfig } from './config'
import { getInstance, getInstances, ensureWorkspace, instanceDshHome, stripBomIfPresent, ensureProfile } from './instances'
import { t } from './i18n'
import { bundledEnv, currentDshVersion, resolveBundledDshBin, resolveBundledNode } from './runtime'
import { broadcast } from './bus'
import { ensureRuntimeLinks } from './plugins'
import type { DshInstance, HarnessState, LauncherConfig, LogLine } from '../shared/types'

const MAX_LOG = 6000
// Strip ANSI colour/control sequences so the console stays clean.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

interface Runtime {
  instanceId: string
  child: ChildProcess | null
  state: HarnessState
  log: LogLine[]
  portTimer: NodeJS.Timeout | null
  startTimer: NodeJS.Timeout | null
  stopping: boolean
  /** 同步防并发双启动:startInstance 入口置位,函数返回/异常后清除。 */
  starting: boolean
  /** 主动停止完成的时间戳(ms);external 判定冷却期起点,0 表示未停止过。 */
  stoppedAt: number
  /** 跨 chunk 的行缓冲:stdout/stderr 分界处的半行在下一 chunk 续接,防止日志行被截断。 */
  pending: { stdout: string; stderr: string }
  /** Actual bound port: the configured one, or parsed from dsh's log when the instance uses port 0. */
  effectivePort: number
  /** Last time the child produced any output (for the stuck-detection grace period). */
  lastOutputAt: number
}

// Startup timeout is not a hard wall-clock deadline: dsh cold boots (source
// build, many plugins) can legitimately take minutes while still printing
// progress. The timer only marks a failure once the process has been *silent*
// for START_IDLE_GRACE — alive-but-idle is the real "stuck" signal. Every
// START_CHECK_INTERVAL a "still starting" notice is emitted so a long boot
// never reads as hung.
const START_IDLE_GRACE = 120_000
const START_CHECK_INTERVAL = 15_000

const runtimes = new Map<string, Runtime>()

function makeState(inst: DshInstance): HarnessState {
  return {
    instanceId: inst.id,
    status: 'stopped',
    pid: null,
    profile: inst.profile,
    port: inst.port,
    startedAt: null,
    ready: false,
    exitCode: null,
    lastError: null,
    pendingRestart: false
  }
}

function ensureRuntime(id: string): Runtime {
  const inst = getInstance(id)
  let rt = runtimes.get(id)
  if (!rt) {
    rt = {
      instanceId: id,
      child: null,
      state: inst ? makeState(inst) : { instanceId: id, status: 'stopped', pid: null, profile: 'web', port: 0, startedAt: null, ready: false, exitCode: null, lastError: null, pendingRestart: false },
      log: [],
      portTimer: null,
      startTimer: null,
      stopping: false,
      starting: false,
      stoppedAt: 0,
      pending: { stdout: '', stderr: '' },
      effectivePort: inst?.port ?? 0,
      lastOutputAt: 0
    }
    runtimes.set(id, rt)
  }
  return rt
}

export function getState(id: string): HarnessState {
  return { ...ensureRuntime(id).state }
}

export function getLog(id: string): LogLine[] {
  return ensureRuntime(id).log.slice()
}

/**
 * Mark a running instance as awaiting a manual restart (its plugin set changed
 * and only takes effect on next boot). Ignored unless the instance is running —
 * a stopped instance simply picks the change up when it starts.
 */
export function markPendingRestart(id: string): void {
  const rt = ensureRuntime(id)
  if (rt.state.status !== 'running') return
  patch(rt, { pendingRestart: true })
}

/** States for every configured instance (id → state), used by the boot bootstrap. */
export function getAllStates(): Record<string, HarnessState> {
  const out: Record<string, HarnessState> = {}
  for (const inst of getInstances()) out[inst.id] = getState(inst.id)
  return out
}

export function getAllLogs(): Record<string, LogLine[]> {
  const out: Record<string, LogLine[]> = {}
  for (const inst of getInstances()) out[inst.id] = getLog(inst.id)
  return out
}

function patch(rt: Runtime, p: Partial<HarnessState>): void {
  rt.state = { ...rt.state, ...p }
  broadcast({ type: 'state', state: getState(rt.instanceId) })
}

function pushLine(rt: Runtime, stream: 'stdout' | 'stderr', raw: string): void {
  const line = raw.replace(ANSI, '')
  if (!line) return
  const at = Date.now()
  rt.lastOutputAt = at
  rt.log.push({ stream, line, at })
  if (rt.log.length > MAX_LOG) rt.log.splice(0, rt.log.length - MAX_LOG)
  broadcast({ type: 'log', stream, line, at, instanceId: rt.instanceId })
  // Port 0 instances: adopt the actual port from dsh's own log output once it
  // prints the web URL, so the probe and the embedded view know where to look.
  if (rt.effectivePort === 0 && getInstance(rt.instanceId)?.port === 0) {
    const port = parsePortFromLine(line)
    if (port && port > 0) {
      rt.effectivePort = port
      patch(rt, { port })
    }
  }
}

/** Match `http(s)://host:port` / `ws(s)://host:port` and return the port. */
function parsePortFromLine(line: string): number | null {
  const m = line.match(/(?:https?|wss?):\/\/(?:\[[^\]]*\]|[^\s/:]+)(?::(\d+))?(?:\/|$|\s)/i)
  if (m && m[1]) return Number(m[1])
  return null
}

function chunkToLines(rt: Runtime, stream: 'stdout' | 'stderr'): (chunk: Buffer) => void {
  return (chunk: Buffer) => {
    // 行缓冲:一个 chunk 里的半行可能在下个 chunk 续完,直接 split 会把一行拆成
    // 两段错误日志。挂到 rt.pending,进程退出时统一 flush。
    rt.pending[stream] += chunk.toString('utf8')
    const lines = rt.pending[stream].split(/\r?\n/)
    rt.pending[stream] = lines.pop() ?? ''
    for (const line of lines) pushLine(rt, stream, line)
  }
}

interface LaunchPlan {
  cmd: string
  args: string[]
  cwd: string
  envPatch?: NodeJS.ProcessEnv
}

/** Resolve a possibly-relative script arg against the harness repo (source mode). */
function resolveScriptArgs(args: string[], base: string): string[] {
  return args.map(a => {
    if (a.startsWith('-') || isAbsolute(a)) return a
    const abs = join(base, a)
    return existsSync(abs) ? abs : a
  })
}

/** 当前运行中的 dsh 版本:内置(bundled)读 .dsh-runtime 安装版本;源码版读 harness 仓库版本。 */
function dshVersionOf(cfg: LauncherConfig): string | null {
  if (cfg.installMode === 'bundled') return currentDshVersion()
  try {
    const p = join(cfg.harnessRepo, 'package.json')
    if (!existsSync(p)) return null
    return String((JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }).version ?? '')
  } catch {
    return null
  }
}

/**
 * --no-open 参数存在于 dsh 0.1.0-rc.7 及之后(含 0.1.1-* 新版本线)。
 * 注意 0.1.1-rc.2 的 rc 号是 2,不能用「rc>=7」判断,要按主版本比较:
 * patch>=1(0.1.1+)或 (patch==0 && rc>=7)。
 */
function dshSupportsNoOpen(version: string | null): boolean {
  if (!version) return false
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/.exec(version.trim())
  if (!m) return false
  const [, , , patch, rc] = m
  const n = (x?: string): number => Number(x ?? 0)
  if (n(patch) >= 1) return true
  return n(rc) >= 7
}

/** Decide how to launch dsh for one instance based on the install mode. */
function launchPlan(cfg: LauncherConfig, inst: DshInstance): LaunchPlan {
  // dsh's CLI boots any named profile via `--profile <name>` — the `web`
  // subcommand is just an alias for `--profile web`, so the flag works for the
  // default instance too. A bare positional would be handed to the booted app
  // and the CLI would error with "--profile <name> is required"; instance
  // profiles are auto-named (`web-2`, …), so the flag is required everywhere.
  const inner = [...cfg.launchArgs, '--profile', inst.profile || 'web', '--port', String(inst.port)]
  // --no-open:新版 dsh(0.1.0-rc.7+,含 0.1.1-*)启动 web 后默认会用系统浏览器打开
  // 自身地址,launcher 已有内嵌视图,必须禁用。该参数只存在于**内置(npm 包)**dsh:
  // 源码版本地 harness 不含它(传了报 unknown option,且本地 harness 不自动开浏览器)。
  // 所以仅 bundled 模式按版本传。
  if (cfg.installMode === 'bundled' && dshSupportsNoOpen(dshVersionOf(cfg))) inner.push('--no-open')
  // 实例的 DSH_HOME:独立 home(inst.dshHome)或共享 cfg.dshHome。显式钉住 env,
  // 防系统级 $DSH_HOME 环境变量漂移(共享实例此前未注入,行为是隐式继承)。
  const home = instanceDshHome(inst)
  if (cfg.installMode === 'bundled') {
    const node = resolveBundledNode()
    const bin = resolveBundledDshBin()
    if (!node || !bin) throw new Error(t('内置运行环境未安装 — 请到「设置 → 运行环境」点击「一键安装运行环境」。', 'Built-in runtime not installed — go to Settings → Runtime and click "Install runtime".'))
    return {
      cmd: node,
      args: inner,
      cwd: ensureWorkspace(inst),
      envPatch: { ...bundledEnv(), DSH_HOME: home }
    }
  }
  return {
    cmd: cfg.nodePath,
    args: resolveScriptArgs(inner, cfg.harnessRepo),
    cwd: ensureWorkspace(inst),
    envPatch: { DSH_HOME: home }
  }
}

export async function startInstance(id: string): Promise<{ ok: boolean; error?: string }> {
  const inst = getInstance(id)
  if (!inst) return { ok: false, error: t('实例不存在。', 'Instance not found.') }
  const rt = ensureRuntime(id)
  // 同步防并发双启动:两处检查都在任何 await 之前完成;第二个并发调用看到
  // rt.starting 立即被拒,杜绝「rt.child 尚未赋值 → 双 spawn → 首个进程泄漏」。
  if (rt.child) return { ok: false, error: t(`实例「${inst.name}」已在运行`, `Instance "${inst.name}" is already running`) }
  if (rt.starting) return { ok: false, error: t(`实例「${inst.name}」正在启动中,请稍候`, `Instance "${inst.name}" is starting, please wait`) }
  rt.starting = true
  try {
    return await startInstanceInner(inst, rt)
  } finally {
    rt.starting = false
  }
}

async function startInstanceInner(inst: DshInstance, rt: Runtime): Promise<{ ok: boolean; error?: string }> {
  const cfg = getConfig()
  const home = instanceDshHome(inst)
  // 独立 home 缺失 → 快速失败(纯解析、不兜底,防止静默回退到共享 home 的隐蔽错位)。
  if (inst.dshHome != null && !existsSync(home)) {
    return { ok: false, error: t(`实例的独立 DSH_HOME 不存在(可能已被删除): ${home}`, `Instance's isolated DSH_HOME is missing (may have been deleted): ${home}`) }
  }
  // 启动前自愈链接插件的运行时解析层(junction 被清理/重建时重建;幂等、毫秒级,
  // 失败只记日志不阻塞启动——真正的解析错误会由 dsh 启动本身暴露)。
  try {
    await ensureRuntimeLinks(home, inst.profile)
  } catch (e) {
    pushLine(rt, 'stderr', t(`[launcher] 运行时链接层自愈失败: ${String(e)}`, `[launcher] Failed to self-heal the runtime link layer: ${String(e)}`))
  }
  // 剥离 profile manifest 的 UTF-8 BOM:Windows 记事本等外部工具改写 package.json
  // 时可能写入 BOM,dsh 内核 JSON.parse 不认 BOM 会启动即失败。启动前自愈,幂等。
  if (stripBomIfPresent(join(home, 'profiles', inst.profile, 'package.json'))) {
    pushLine(rt, 'stderr', t(`[launcher] 已修复 profile manifest 的 UTF-8 BOM: ${inst.profile}/package.json`, `[launcher] Stripped UTF-8 BOM from profile manifest: ${inst.profile}/package.json`))
  }
  // 确保 profile 目录物理存在:dsh 内核只对 web/headless 自动初始化,web-2 这类
  // 名字在目录缺失时启动即报 "profile does not exist"(共享模式实例的目录可能因
  // 手动清理/历史遗留而缺失)。启动前按模板补建,自愈。
  const profileDirPath = join(home, 'profiles', inst.profile)
  if (!existsSync(profileDirPath)) {
    ensureProfile(inst.profile, home)
    pushLine(rt, 'stderr', t(`[launcher] 检测到缺失的 profile,已自动补建: ${inst.profile}`, `[launcher] Missing profile detected; auto-created: ${inst.profile}`))
  } else {
    ensureProfile(inst.profile, home)
  }
  let plan: LaunchPlan
  try {
    plan = launchPlan(cfg, inst)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (cfg.installMode === 'source' && (!plan.cwd || !existsSync(plan.cwd))) {
    return { ok: false, error: t(`harness 仓库不存在: ${plan.cwd}`, `harness repo not found: ${plan.cwd}`) }
  }

  // A listener on a fixed port means either an external dsh the user started, or
  // a leftover dsh orphaned by a previous launcher run that didn't shut down
  // cleanly (taskkill from a killed/crashed launcher can miss it). The latter is
  // the "works the first time, hangs the second" failure: the stale process still
  // holds the port but its server is dead, so the embedded view just spins. When
  // the listener is recognisably a dsh process, reclaim the port instead of
  // erroring; anything else is a genuine conflict we must not touch.
  if (inst.port > 0 && (await portInUse(inst.port))) {
    const pid = await findListeningPid(inst.port)
    if (pid && (await isLeftoverDsh(pid))) {
      pushLine(rt, 'stderr', t(`[launcher] 检测到残留的 dsh 进程 (pid=${pid}),清理后重新启动…`, `[launcher] Detected a leftover dsh process (pid=${pid}); cleaning up and restarting…`))
      await killPid(pid)
      await delay(1500)
    } else {
      return {
        ok: false,
        error: t(
          `端口 ${inst.port} 已被占用 (pid=${pid ?? '?'}) — 可能有另一个 dsh 实例正在运行,请先停止它再启动。`,
          `Port ${inst.port} is already in use (pid=${pid ?? '?'}) — another dsh instance may be running; stop it first.`
        )
      }
    }
  }

  rt.effectivePort = inst.port
  patch(rt, {
    status: 'starting',
    pid: null,
    profile: inst.profile,
    port: inst.port,
    startedAt: Date.now(),
    ready: false,
    exitCode: null,
    lastError: null
  })
  pushLine(rt, 'stderr', t(`[launcher] 启动 dsh profile "${inst.profile}" (${cfg.installMode === 'bundled' ? '内置运行环境' : '源码版'})`, `[launcher] Starting dsh profile "${inst.profile}" (${cfg.installMode === 'bundled' ? 'bundled runtime' : 'source build'})`))
  pushLine(rt, 'stderr', `[launcher] DSH_HOME=${home}`)
  pushLine(rt, 'stderr', `[launcher] ${plan.cmd} ${plan.args.join(' ')}`)

  let proc: ChildProcess
  try {
    proc = spawn(plan.cmd, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...(plan.envPatch ?? {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    patch(rt, { status: 'error', lastError: message })
    pushLine(rt, 'stderr', t(`[launcher] 启动失败: ${message}`, `[launcher] Failed to start: ${message}`))
    return { ok: false, error: message }
  }

  rt.child = proc
  rt.stopping = false
  rt.stoppedAt = 0 // 新进程存活,external 判定冷却期结束
  rt.lastOutputAt = Date.now()
  patch(rt, { pid: proc.pid ?? null })

  proc.stdout?.on('data', chunkToLines(rt, 'stdout'))
  proc.stderr?.on('data', chunkToLines(rt, 'stderr'))
  proc.on('error', (err) => {
    pushLine(rt, 'stderr', t(`[launcher] 进程错误: ${err.message}`, `[launcher] Process error: ${err.message}`))
    patch(rt, { status: 'error', lastError: err.message })
  })
  proc.on('exit', (code, signal) => {
    // 进程结束时 flush 行缓冲里未换行的尾行。
    for (const s of ['stdout', 'stderr'] as const) {
      if (rt.pending[s]) {
        pushLine(rt, s, rt.pending[s])
        rt.pending[s] = ''
      }
    }
    pushLine(rt, 'stderr', t(`[launcher] 进程退出 code=${code ?? 'null'} signal=${signal ?? 'none'}`, `[launcher] Process exited code=${code ?? 'null'} signal=${signal ?? 'none'}`))
    rt.child = null
    stopPortProbe(rt)
    clearStartTimer(rt)
    if (!rt.stopping) {
      // Exited on its own.
      if (rt.state.status === 'running' || rt.state.status === 'starting') {
        patch(rt, { status: 'error', pid: null, ready: false, exitCode: code, lastError: code === 0 ? null : t('进程意外退出', 'Process exited unexpectedly') })
      } else {
        patch(rt, { status: 'stopped', pid: null, ready: false, exitCode: code })
      }
    } else {
      patch(rt, { status: 'stopped', pid: null, ready: false, exitCode: code })
      rt.stopping = false
    }
  })

  startPortProbe(rt)
  // Lazy startup check: `startupTimeoutMs` is just the first review point, not
  // a death sentence. As long as the child is alive and still emitting output,
  // it is mid-boot (cold source-build boots with many plugins can take minutes);
  // only a silent process gets marked as timed out. If the port becomes ready
  // later anyway, startPortProbe recovers the state to 'running'.
  const checkStart = (): void => {
    if (rt.state.status !== 'starting' || !rt.child) return // exit handler finalizes
    const idle = Date.now() - rt.lastOutputAt
    if (idle < START_IDLE_GRACE) {
      const elapsed = Math.round((Date.now() - (rt.state.startedAt ?? Date.now())) / 1000)
      pushLine(
        rt,
        'stderr',
        t(
          `[launcher] 启动较慢(已 ${elapsed}s),进程仍在输出,继续等待端口就绪…`,
          `[launcher] Startup is slow (${elapsed}s elapsed); the process is still producing output, keeping waiting for the port…`
        )
      )
      rt.startTimer = setTimeout(checkStart, START_CHECK_INTERVAL)
      return
    }
    pushLine(
      rt,
      'stderr',
      t(
        `[launcher] 启动超时 — 进程已 ${Math.round(idle / 1000)}s 无输出,端口 ${rt.effectivePort} 仍未就绪,可能已卡死`,
        `[launcher] Startup timeout — the process has produced no output for ${Math.round(idle / 1000)}s and port ${rt.effectivePort} is still not ready; it may be stuck`
      )
    )
    patch(rt, { status: 'error', lastError: t('启动超时 — 端口未就绪,请检查日志', 'Startup timeout — port not ready, check the logs') })
  }
  rt.startTimer = setTimeout(checkStart, cfg.startupTimeoutMs)
  return { ok: true }
}

function clearStartTimer(rt: Runtime): void {
  if (rt.startTimer) {
    clearTimeout(rt.startTimer)
    rt.startTimer = null
  }
}

function startPortProbe(rt: Runtime): void {
  stopPortProbe(rt)
  rt.portTimer = setInterval(() => {
    if (!rt.child) {
      stopPortProbe(rt)
      return
    }
    if (rt.effectivePort <= 0) return // waiting for dsh to print its actual port
    probePort(rt.effectivePort, (ok) => {
      // 'error' may recover: a slow boot that got flagged by checkStart is still
      // coming up — once the port really opens (child alive), self-heal to
      // 'running' instead of reporting a success as a failure.
      if (ok && rt.child && (rt.state.status === 'starting' || rt.state.status === 'error')) {
        pushLine(rt, 'stdout', t(`[launcher] ✔ 就绪 — Web UI: http://127.0.0.1:${rt.effectivePort}`, `[launcher] ✔ Ready — Web UI: http://127.0.0.1:${rt.effectivePort}`))
        // A manual restart has applied any pending plugin changes — clear the flag.
        patch(rt, { status: 'running', ready: true, port: rt.effectivePort, pendingRestart: false, lastError: null })
        stopPortProbe(rt)
        clearStartTimer(rt)
      }
    })
  }, 500)
}

function stopPortProbe(rt: Runtime): void {
  if (rt.portTimer) {
    clearInterval(rt.portTimer)
    rt.portTimer = null
  }
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => probePort(port, resolve))
}

function probePort(port: number, cb: (ok: boolean) => void): void {
  const sock = createConnection({ host: '127.0.0.1', port })
  let settled = false
  const done = (ok: boolean): void => {
    if (settled) return
    settled = true
    sock.destroy()
    cb(ok)
  }
  sock.setTimeout(500, () => done(false))
  sock.once('connect', () => done(true))
  sock.once('error', () => done(false))
}

/** Find the PID listening on a TCP port (Windows netstat). */
function findListeningPid(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null)
      return
    }
    let out = ''
    const proc = spawn('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    proc.on('error', () => resolve(null))
    proc.on('close', () => {
      const re = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|\\[::\\]):${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i')
      const m = out.match(re)
      resolve(m ? Number(m[1]) : null)
    })
  })
}

/** Read a process's full command line (Windows PowerShell). */
function processCommandLine(pid: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve('')
      return
    }
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    proc.on('error', () => resolve(''))
    proc.on('close', () => resolve(out.trim()))
  })
}

/** True when the process at `pid` is a dsh server (portable/source node running the dsh bin). */
async function isLeftoverDsh(pid: number): Promise<boolean> {
  const cmdline = await processCommandLine(pid)
  return /deepseek-ai|deepseek-harness|bin\.js/i.test(cmdline)
}

/** Force-kill a process tree by pid. */
function killPid(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
      k.on('close', () => resolve())
      k.on('error', () => resolve())
    } else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      resolve()
    }
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Reconcile an instance's state with reality on a timer.
 * - No managed child: a port listener we didn't start ⇒ an external dsh instance
 *   is running. Adopt it as state 'external' (with its PID); flip back to
 *   'stopped' once the port frees.
 * - Managed child in 'running': a dropped port means the server crashed/hung
 *   even though the process is still alive.
 */
async function tickMonitor(rt: Runtime): Promise<void> {
  const port = rt.effectivePort
  if (port <= 0) return
  // 主动停止后的冷却期:taskkill /T 异步释放端口,可能滞后数秒;此期间不把刚停止的
  // 实例误判为「外部 DSH 实例」——否则点过停止,状态却跳成 external,看着像复活。
  if (rt.stoppedAt !== 0 && Date.now() - rt.stoppedAt < 5000) return
  if (!rt.child) {
    const inUse = await portInUse(port)
    if (inUse) {
      if (rt.state.status !== 'external' && rt.state.status !== 'stopping') {
        const pid = await findListeningPid(port)
        pushLine(rt, 'stderr', t(`[launcher] 检测到外部 DSH 实例 (pid=${pid ?? '?'}),端口 ${port} 已被占用`, `[launcher] Detected an external DSH instance (pid=${pid ?? '?'}), port ${port} is in use`))
        patch(rt, { status: 'external', pid, ready: true, startedAt: null, exitCode: null, lastError: null })
      }
    } else if (rt.state.status === 'external' || rt.state.status === 'stopping') {
      // External instance gone, or our external-kill finished.
      patch(rt, { status: 'stopped', pid: null, ready: false })
    }
  } else if (rt.state.status === 'running') {
    const inUse = await portInUse(port)
    if (!inUse) {
      pushLine(rt, 'stderr', t(`[launcher] 端口 ${port} 连接中断,进程可能已异常`, `[launcher] Connection to port ${port} lost — the process may have crashed`))
      patch(rt, { status: 'error', ready: false, lastError: t('端口连接中断,进程可能已异常', 'Connection to the port was lost — the process may have crashed') })
    }
  }
}

// One global monitor walks every configured instance, so instances added later
// are picked up automatically and removed ones are pruned.
let monitorTimer: NodeJS.Timeout | null = null

function startMonitor(): void {
  stopMonitor()
  monitorTimer = setInterval(() => {
    for (const inst of getInstances()) void tickMonitor(ensureRuntime(inst.id))
    // Drop runtimes whose instance was deleted (child already stopped by IPC).
    for (const [id, rt] of runtimes) {
      if (!getInstance(id) && !rt.child) {
        stopPortProbe(rt)
        clearStartTimer(rt)
        runtimes.delete(id)
      }
    }
  }, 2500)
  // Probe once shortly after boot so the initial state is correct.
  setTimeout(() => {
    for (const inst of getInstances()) void tickMonitor(ensureRuntime(inst.id))
  }, 800)
}

function stopMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
  }
}

// Start the external-state monitor as soon as the module loads.
startMonitor()

/** Start every *shown* instance with autoStart enabled (boot-time). */
export function startAllAutoStart(): void {
  for (const inst of getInstances()) {
    if (inst.enabled !== false && inst.autoStart) {
      void startInstance(inst.id).then((r) => {
        if (!r.ok) console.error('[launcher] auto-start failed for', inst.name, ':', r.error)
      })
    }
  }
}

export function stopInstance(id: string): Promise<void> {
  return stopRuntime(ensureRuntime(id))
}

function stopRuntime(rt: Runtime): Promise<void> {
  return new Promise((resolve) => {
    const proc = rt.child
    if (!proc) {
      stopPortProbe(rt)
      if (rt.state.status === 'external' && rt.state.pid) {
        // Kill the externally-started instance so the launcher can take over.
        const pid = rt.state.pid
        pushLine(rt, 'stderr', t(`[launcher] 停止外部实例 (pid=${pid})`, `[launcher] Stopping external instance (pid=${pid})`))
        patch(rt, { status: 'stopping', pid: null, ready: false })
        if (process.platform === 'win32') {
          const kill = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
          const settle = (): void => {
            rt.stoppedAt = Date.now()
            resolve()
          }
          kill.on('error', settle)
          kill.on('close', settle)
        } else {
          // Best-effort: the monitor flips back to 'stopped' once the port frees.
          try {
            process.kill(pid, 'SIGTERM')
          } catch {
            /* ignore */
          }
          rt.stoppedAt = Date.now()
          resolve()
        }
        return
      }
      rt.stoppedAt = Date.now()
      patch(rt, { status: 'stopped', pid: null, ready: false })
      resolve()
      return
    }
    if (rt.stopping) {
      // Already stopping; resolve when exit handler fires.
      const waiter = setInterval(() => {
        if (!rt.child) {
          clearInterval(waiter)
          resolve()
        }
      }, 100)
      return
    }

    rt.stopping = true
    patch(rt, { status: 'stopping' })
    stopPortProbe(rt)
    clearStartTimer(rt)
    pushLine(rt, 'stderr', t(`[launcher] 停止进程 (pid=${proc.pid ?? '?'})`, `[launcher] Stopping process (pid=${proc.pid ?? '?'})`))

    let resolved = false
    const finish = (): void => {
      if (resolved) return
      resolved = true
      rt.stoppedAt = Date.now()
      patch(rt, { status: 'stopped', pid: null, ready: false })
      resolve()
    }
    proc.once('exit', finish)
    const timer = setTimeout(finish, 8000)

    if (process.platform === 'win32' && proc.pid) {
      // Kill the whole process tree (dsh may spawn children).
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true, stdio: 'ignore' }).unref()
    } else if (proc.pid) {
      try {
        process.kill(proc.pid, 'SIGTERM')
      } catch {
        try {
          proc.kill()
        } catch {
          /* already gone */
        }
      }
    } else {
      proc.kill()
    }
    timer.unref?.()
  })
}

export function restartInstance(id: string): Promise<{ ok: boolean; error?: string }> {
  return stopInstance(id).then(() => startInstance(id))
}

/** Stop every managed instance (and any adopted externals). */
export function stopAll(): Promise<void> {
  return Promise.all([...runtimes.values()].map((rt) => stopRuntime(rt))).then(() => undefined)
}

/** Synchronous best-effort kill for app quit — the taskkill child is detached so it survives Electron exiting. */
export function stopAllSync(): void {
  for (const rt of runtimes.values()) {
    const proc = rt.child
    if (!proc) continue
    stopPortProbe(rt)
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    } else {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }
    rt.child = null
  }
}
