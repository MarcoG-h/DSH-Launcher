// Shared task helpers: run a child process and stream its output as a task
// (used by plugins.ts for installs/builds and runtime.ts for the portable install).

import { spawn } from 'node:child_process'
import { broadcast } from './bus'
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
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r > 0 ? `${m} 分 ${r} 秒` : `${m} 分`
}

/** Stream a child process and broadcast its output as a task. */
export function runAsync(cmd: string, args: string[], cwd: string, label: string, useShell: boolean, envPatch?: NodeJS.ProcessEnv): Promise<CmdResult> {
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
    const emit = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').replace(ANSI, '').split(/\r?\n/)) {
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
      taskLine(label, `[task] 仍在执行中,已运行 ${formatElapsed(Math.round((Date.now() - started) / 1000))} — 暂无新输出,请耐心等待…`)
    }, 10_000)
    const stopWatchdog = (): void => clearInterval(watchdog)
    const touch = (): void => {
      lastOutput = Date.now()
    }
    child.stdout?.on('data', (c) => {
      touch()
      emit('stdout')(c)
    })
    child.stderr?.on('data', (c) => {
      touch()
      emit('stderr')(c)
    })
    child.on('error', (err) => {
      stopWatchdog()
      broadcast({ type: 'task', task: { label, status: 'end', code: null } })
      resolve({ ok: false, code: null, error: err.message })
    })
    child.on('close', (code) => {
      stopWatchdog()
      broadcast({ type: 'task', task: { label, status: 'end', code } })
      resolve({ ok: code === 0, code })
    })
  })
}
