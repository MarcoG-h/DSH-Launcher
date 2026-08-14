import { spawn, type ChildProcess } from 'node:child_process'
import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { getConfig } from './config'
import { broadcast } from './bus'
import type { HarnessState, LogLine } from '../shared/types'

const MAX_LOG = 6000
// Strip ANSI colour/control sequences so the console stays clean.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

let child: ChildProcess | null = null
let portTimer: NodeJS.Timeout | null = null
let startTimer: NodeJS.Timeout | null = null
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

export async function start(): Promise<{ ok: boolean; error?: string }> {
  if (child) return { ok: false, error: 'harness 已在运行' }
  const cfg = getConfig()
  const cwd = cfg.harnessRepo
  if (!cwd || !existsSync(cwd)) return { ok: false, error: `harness 仓库不存在: ${cwd}` }

  // Refuse to race an existing listener (e.g. a dsh instance started outside the launcher).
  if (await portInUse(cfg.port)) {
    return { ok: false, error: `端口 ${cfg.port} 已被占用 — 可能有另一个 dsh 实例正在运行,请先停止它再启动。` }
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
  pushLine('stderr', `[launcher] 启动 dsh profile "${cfg.profile}" @ ${cwd}`)
  pushLine('stderr', `[launcher] ${cfg.nodePath} ${[...cfg.launchArgs, cfg.profile].join(' ')}`)

  let proc: ChildProcess
  try {
    proc = spawn(cfg.nodePath, [...cfg.launchArgs, cfg.profile], {
      cwd,
      env: { ...process.env },
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
        if (getConfig().autoOpenUi) {
          pushLine('stdout', `[launcher] 自动打开 Web UI…`)
          void shell.openExternal(`http://127.0.0.1:${port}`)
        }
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

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    const proc = child
    if (!proc) {
      stopPortProbe()
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
