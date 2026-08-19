// Shared task helpers: run a child process and stream its output as a task
// (used by plugins.ts for installs/builds and runtime.ts for the portable install).

import { spawn } from 'node:child_process'
import { broadcast } from './bus'
import { t } from './i18n'
import type { CmdResult } from '../shared/types'

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

/** Emit a plain progress line for a task (does not reset the task console). */
export function taskLine(label: string, line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
  broadcast({ type: 'task', task: { label, status: 'start', code: null, stream, line } })
}

/** Emit a progress/phase update for a running task (progress 0..1, or null for indeterminate). */
export function taskProgress(label: string, progress: number | null, phase?: string): void {
  broadcast({ type: 'task', task: { label, status: 'start', code: null, progress: progress ?? undefined, phase } })
}

/** Close a task that never spawned a child (skipped path). */
export function taskDone(label: string, code: number): void {
  broadcast({ type: 'task', task: { label, status: 'end', code } })
}

function formatElapsed(s: number): string {
  if (s < 60) return t(`${s} 秒`, `${s} sec`)
  const m = Math.floor(s / 60)
  const r = s % 60
  return r > 0 ? t(`${m} 分 ${r} 秒`, `${m} min ${r} sec`) : t(`${m} 分`, `${m} min`)
}

/**
 * Stream a child process and broadcast its output as a task.
 * `timeoutMs` (optional) kills the whole process tree after the deadline with a
 * clear error — guards against e.g. `git` waiting forever for a credential
 * prompt that has no terminal to read from.
 */
export function runAsync(cmd: string, args: string[], cwd: string, label: string, useShell: boolean, envPatch?: NodeJS.ProcessEnv, timeoutMs?: number, redact?: string): Promise<CmdResult> {
  return new Promise((resolve) => {
    broadcast({ type: 'task', task: { label, status: 'start', code: null } })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        cwd,
        shell: useShell,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0', ...envPatch }
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      broadcast({ type: 'task', task: { label, status: 'end', code: null } })
      resolve({ ok: false, code: null, error })
      return
    }

    let settled = false
    let timedOut = false
    let timer: NodeJS.Timeout | null = null
    // Keep the tail of stderr so callers can diagnose failures (e.g. pnpm's
    // ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED names the offending package). No
    // stderr is shown in the UI, only attached to the CmdResult.
    let stderrTail = ''
    const STDERR_CAP = 8192
    const appendStderr = (text: string): void => {
      stderrTail = (stderrTail + text).slice(-STDERR_CAP)
    }
    const withStderr = (r: CmdResult): CmdResult => (stderrTail ? { ...r, stderr: stderrTail } : r)
    const finish = (result: CmdResult): void => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      resolve(result)
    }

    const safe = (line: string): string => (redact ? line.split(redact).join('***') : line)
    const emit = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').replace(ANSI, '').split(/\r?\n/)) {
        const line = safe(raw)
        if (line.trim()) broadcast({ type: 'task', task: { label, status: 'start', code: null, stream, line } })
      }
    }
    // Liveness watchdog: if the child emits nothing for 30s (e.g. npm on a slow
    // registry), print a line so a slow step never reads as "hung".
    const started = Date.now()
    let lastOutput = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutput < 30_000) return
      lastOutput = Date.now()
      taskLine(label, t(`[task] 仍在执行中,已运行 ${formatElapsed(Math.round((Date.now() - started) / 1000))} — 暂无新输出,请耐心等待…`, `[task] Still running (${formatElapsed(Math.round((Date.now() - started) / 1000))}) — no new output yet, please wait…`))
    }, 10_000)
    const stopWatchdog = (): void => clearInterval(watchdog)
    const touch = (): void => {
      lastOutput = Date.now()
    }

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        try {
          if (process.platform === 'win32' && child.pid) {
            // Kill the whole tree (shell:true wraps git in cmd.exe on Windows).
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
          } else {
            child.kill('SIGKILL')
          }
        } catch {
          /* ignore — close event settles the promise */
        }
      }, timeoutMs)
    }

    child.stdout?.on('data', (c) => {
      touch()
      emit('stdout')(c)
    })
    child.stderr?.on('data', (c) => {
      touch()
      appendStderr(c.toString('utf8'))
      emit('stderr')(c)
    })
    child.on('error', (err) => {
      stopWatchdog()
      broadcast({ type: 'task', task: { label, status: 'end', code: null } })
      finish(withStderr({ ok: false, code: null, error: err.message }))
    })
    child.on('close', (code) => {
      stopWatchdog()
      broadcast({ type: 'task', task: { label, status: 'end', code } })
      if (timedOut) {
        finish(
          withStderr({
            ok: false,
            code: null,
            error: t(
              '操作超时,已终止。可能网络较慢,或该仓库为私有/不存在(需登录,可在 设置→系统管理 填写 GitHub 访问令牌)。',
              'Operation timed out and was aborted. The network may be slow, or the repo is private/nonexistent (login required — add a GitHub access token in Settings → System).'
            )
          })
        )
      } else {
        finish(withStderr({ ok: code === 0, code }))
      }
    })
  })
}
