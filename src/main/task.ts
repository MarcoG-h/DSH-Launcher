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

/** Close a task that never spawned a child (skipped path). */
export function taskDone(label: string, code: number): void {
  broadcast({ type: 'task', task: { label, status: 'end', code } })
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
    child.stdout?.on('data', emit('stdout'))
    child.stderr?.on('data', emit('stderr'))
    child.on('error', (err) => {
      broadcast({ type: 'task', task: { label, status: 'end', code: null } })
      resolve({ ok: false, code: null, error: err.message })
    })
    child.on('close', (code) => {
      broadcast({ type: 'task', task: { label, status: 'end', code } })
      resolve({ ok: code === 0, code })
    })
  })
}
