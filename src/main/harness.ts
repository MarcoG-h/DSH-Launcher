import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { getActiveApiPreset, getConfig } from './config'
import { bundledEnv, resolveBundledDshBin, resolveBundledNode } from './runtime'
import { broadcast } from './bus'
import type { HarnessState, LauncherConfig, LogLine } from '../shared/types'

const MAX_LOG = 6000
// Strip ANSI colour/control sequences so the console stays clean.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

let child: ChildProcess | null = null
let portTimer: NodeJS.Timeout | null = null
let startTimer: NodeJS.Timeout | null = null
let monitorTimer: NodeJS.Timeout | null = null
let stopping = false

let state: HarnessState = {
  status: 'stopped',
  pid: null,
  profile: 'web',
  port: 3080,
  startedAt: null,
  ready: false,
  exitCode: null,
  lastError: null
}

const log: LogLine[] = []

export function getState(): HarnessState {
  return { ...state }
}

export function getLog(): LogLine[] {
  return log.slice()
}

function patch(p: Partial<HarnessState>): void {
  state = { ...state, ...p }
  broadcast({ type: 'state', state: getState() })
}

function pushLine(stream: 'stdout' | 'stderr', raw: string): void {
  const line = raw.replace(ANSI, '')
  if (!line) return
  const at = Date.now()
  log.push({ stream, line, at })
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
  broadcast({ type: 'log', stream, line, at })
}

function chunkToLines(stream: 'stdout' | 'stderr'): (chunk: Buffer) => void {
  return (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    // Split into lines but keep trailing partials? Simpler: emit each CR/LF-terminated line.
    for (const line of text.split(/\r?\n/)) pushLine(stream, line)
  }
}

interface LaunchPlan {
  cmd: string
  args: string[]
  cwd: string
  envPatch?: NodeJS.ProcessEnv
}

/** Decide how to launch dsh based on the install mode. */
function launchPlan(cfg: LauncherConfig): LaunchPlan {
  if (cfg.installMode === 'bundled') {
    const node = resolveBundledNode()
    const bin = resolveBundledDshBin()
    if (!node || !bin) throw new Error('内置运行环境未安装 — 请到「设置 → 运行环境」点击「一键安装运行环境」。')
    return {
      cmd: node,
      args: [...cfg.launchArgs, cfg.profile],
      cwd: cfg.runtimeRoot,
      envPatch: bundledEnv()
    }
  }
  return {
    cmd: cfg.nodePath,
    args: [...cfg.launchArgs, cfg.profile],
    cwd: cfg.harnessRepo,
    envPatch: undefined
  }
}

export async function start(): Promise<{ ok: boolean; error?: string }> {
  if (child) return { ok: false, error: 'harness 已在运行' }
  const cfg = getConfig()
  let plan: LaunchPlan
  try {
    plan = launchPlan(cfg)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (cfg.installMode === 'source' && (!plan.cwd || !existsSync(plan.cwd))) {
    return { ok: false, error: `harness 仓库不存在: ${plan.cwd}` }
  }

  // Refuse to race an existing listener (e.g. a dsh instance started outside the launcher).
  if (await portInUse(cfg.port)) {
    const pid = await findListeningPid(cfg.port)
    return {
      ok: false,
      error: `端口 ${cfg.port} 已被占用 (pid=${pid ?? '?'}) — 可能有另一个 dsh 实例正在运行,请先停止它再启动。`
    }
  }

  patch({
    status: 'starting',
    pid: null,
    profile: cfg.profile,
    port: cfg.port,
    startedAt: Date.now(),
    ready: false,
    exitCode: null,
    lastError: null
  })
  pushLine('stderr', `[launcher] 启动 dsh profile "${cfg.profile}" (${cfg.installMode === 'bundled' ? '内置运行环境' : '源码版'})`)
  pushLine('stderr', `[launcher] ${plan.cmd} ${plan.args.join(' ')}`)

  // Inject the active API vendor's endpoint AND key. harness reads
  // DEEPSEEK_BASE_URL only from the process env at boot (bootstrap-only), and
  // resolves DEEPSEEK_API_KEY per request with the inherited process env ranked
  // above .credentials.yaml — so both must be provided here at spawn. We merge
  // after envPatch so a bundled-runtime patch always wins.
  const preset = getActiveApiPreset()
  const apiEnv: NodeJS.ProcessEnv = {}
  if (preset.baseUrl) apiEnv.DEEPSEEK_BASE_URL = preset.baseUrl
  if (preset.apiKey?.trim()) apiEnv.DEEPSEEK_API_KEY = preset.apiKey.trim()
  if (apiEnv.DEEPSEEK_BASE_URL) {
    pushLine('stderr', `[launcher] API 厂商: ${preset.name} (${preset.baseUrl})`)
  }
  if (apiEnv.DEEPSEEK_API_KEY) {
    pushLine('stderr', `[launcher] 已注入该厂商的 API Key(${preset.name}) — 模型调用不再需要去 DSH 界面填 key`)
  } else if (apiEnv.DEEPSEEK_BASE_URL) {
    pushLine('stderr', '[launcher] 该预设未填 API Key — 将使用 ~/.dsh/.credentials.yaml 中已存的 key,若无则模型调用会报 MISSING_CREDENTIAL')
  }

  let proc: ChildProcess
  try {
    proc = spawn(plan.cmd, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...(plan.envPatch ?? {}), ...apiEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    patch({ status: 'error', lastError: message })
    pushLine('stderr', `[launcher] 启动失败: ${message}`)
    return { ok: false, error: message }
  }

  child = proc
  stopping = false
  patch({ pid: proc.pid ?? null })

  proc.stdout?.on('data', chunkToLines('stdout'))
  proc.stderr?.on('data', chunkToLines('stderr'))
  proc.on('error', (err) => {
    pushLine('stderr', `[launcher] 进程错误: ${err.message}`)
    patch({ status: 'error', lastError: err.message })
  })
  proc.on('exit', (code, signal) => {
    pushLine('stderr', `[launcher] 进程退出 code=${code ?? 'null'} signal=${signal ?? 'none'}`)
    child = null
    stopPortProbe()
    clearStartTimer()
    if (!stopping) {
      // Exited on its own.
      if (state.status === 'running' || state.status === 'starting') {
        patch({ status: 'error', pid: null, ready: false, exitCode: code, lastError: code === 0 ? null : '进程意外退出' })
      } else {
        patch({ status: 'stopped', pid: null, ready: false, exitCode: code })
      }
    } else {
      patch({ status: 'stopped', pid: null, ready: false, exitCode: code })
      stopping = false
    }
  })

  startPortProbe()
  startTimer = setTimeout(() => {
    if (state.status === 'starting') {
      pushLine('stderr', `[launcher] 启动超时(${cfg.startupTimeoutMs / 1000}s),端口 ${cfg.port} 未就绪`)
      patch({ status: 'error', lastError: '启动超时 — 端口未就绪,请检查日志' })
    }
  }, cfg.startupTimeoutMs)
  return { ok: true }
}

function clearStartTimer(): void {
  if (startTimer) {
    clearTimeout(startTimer)
    startTimer = null
  }
}

function startPortProbe(): void {
  stopPortProbe()
  portTimer = setInterval(() => {
    if (!child) {
      stopPortProbe()
      return
    }
    const port = getConfig().port
    probePort(port, (ok) => {
      if (ok && state.status === 'starting') {
        pushLine('stdout', `[launcher] ✔ 就绪 — Web UI: http://127.0.0.1:${port}`)
        patch({ status: 'running', ready: true })
        stopPortProbe()
        clearStartTimer()
      }
    })
  }, 500)
}

function stopPortProbe(): void {
  if (portTimer) {
    clearInterval(portTimer)
    portTimer = null
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

/**
 * Reconcile the launcher's state with reality on a timer.
 * - No managed child: a port listener we didn't start ⇒ an external dsh instance
 *   is running. Adopt it as state 'external' (with its PID); flip back to
 *   'stopped' once the port frees.
 * - Managed child in 'running': a dropped port means the server crashed/hung
 *   even though the process is still alive.
 */
async function tickMonitor(): Promise<void> {
  const port = getConfig().port
  if (!child) {
    const inUse = await portInUse(port)
    if (inUse) {
      if (state.status !== 'external' && state.status !== 'stopping') {
        const pid = await findListeningPid(port)
        pushLine('stderr', `[launcher] 检测到外部 DSH 实例 (pid=${pid ?? '?'}),端口 ${port} 已被占用`)
        patch({ status: 'external', pid, ready: true, startedAt: null, exitCode: null, lastError: null })
      }
    } else if (state.status === 'external' || state.status === 'stopping') {
      // External instance gone, or our external-kill finished.
      patch({ status: 'stopped', pid: null, ready: false })
    }
  } else if (state.status === 'running') {
    const inUse = await portInUse(port)
    if (!inUse) {
      pushLine('stderr', `[launcher] 端口 ${port} 连接中断,进程可能已异常`)
      patch({ status: 'error', ready: false, lastError: '端口连接中断,进程可能已异常' })
    }
  }
}

function startMonitor(): void {
  stopMonitor()
  monitorTimer = setInterval(() => void tickMonitor(), 2500)
  // Probe once shortly after boot so the initial state is correct.
  setTimeout(() => void tickMonitor(), 800)
}

function stopMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
  }
}

// Start the external-state monitor as soon as the module loads.
startMonitor()

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    const proc = child
    if (!proc) {
      stopPortProbe()
      if (state.status === 'external' && state.pid) {
        // Kill the externally-started instance so the launcher can take over.
        const pid = state.pid
        pushLine('stderr', `[launcher] 停止外部实例 (pid=${pid})`)
        patch({ status: 'stopping', pid: null, ready: false })
        if (process.platform === 'win32') {
          const kill = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
          kill.on('error', () => resolve())
          kill.on('close', () => resolve())
        } else {
          // Best-effort: the monitor flips back to 'stopped' once the port frees.
          try {
            process.kill(pid, 'SIGTERM')
          } catch {
            /* ignore */
          }
          resolve()
        }
        return
      }
      patch({ status: 'stopped', pid: null, ready: false })
      resolve()
      return
    }
    if (stopping) {
      // Already stopping; resolve when exit handler fires.
      const waiter = setInterval(() => {
        if (!child) {
          clearInterval(waiter)
          resolve()
        }
      }, 100)
      return
    }

    stopping = true
    patch({ status: 'stopping' })
    stopPortProbe()
    clearStartTimer()
    pushLine('stderr', `[launcher] 停止进程 (pid=${proc.pid ?? '?'})`)

    let resolved = false
    const finish = (): void => {
      if (resolved) return
      resolved = true
      patch({ status: 'stopped', pid: null, ready: false })
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

export function restart(): Promise<{ ok: boolean; error?: string }> {
  return stop().then(() => start())
}

/** Synchronous best-effort kill for app quit — the taskkill child is detached so it survives Electron exiting. */
export function stopSync(): void {
  const proc = child
  if (!proc) return
  stopPortProbe()
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
  } else {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }
  child = null
}
