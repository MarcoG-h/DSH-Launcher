import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type HarnessState, type LauncherConfig, type LauncherEvent, type LogLine, type TaskLog } from '../lib/api'
import { getLang, translate } from '../i18n'

const MAX_LOG = 4000

interface HarnessContextValue {
  state: HarnessState | null
  log: LogLine[]
  config: LauncherConfig | null
  tasks: Record<string, TaskLog>
  /** task labels that are currently running, in start order */
  runningTasks: string[]
  refresh: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  restart: () => Promise<void>
  openUi: () => Promise<void>
  saveConfig: (patch: Partial<LauncherConfig>) => Promise<void>
  reloadPlugins: () => void
  /** error from the last start/stop/restart action, surfaced in the UI */
  actionError: string | null
  dismissError: () => void
}

const HarnessContext = createContext<HarnessContextValue | null>(null)

export function useHarness(): HarnessContextValue {
  const ctx = useContext(HarnessContext)
  if (!ctx) throw new Error('useHarness must be used within <HarnessProvider>')
  return ctx
}

export function HarnessProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<HarnessState | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [config, setConfig] = useState<LauncherConfig | null>(null)
  const [tasks, setTasks] = useState<Record<string, TaskLog>>({})
  const [runningTasks, setRunningTasks] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const pluginsVersion = useRef(0)

  const reloadPlugins = useCallback(() => {
    pluginsVersion.current += 1
  }, [])

  const refresh = useCallback(async () => {
    try {
      const boot = await api.getState()
      setState(boot.state)
      setLog(boot.log)
      setConfig(boot.config)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = api.onEvent((e: LauncherEvent) => {
      if (e.type === 'state') {
        setState(e.state)
      } else if (e.type === 'log') {
        const entry: LogLine = { stream: e.stream, line: e.line, at: e.at }
        setLog((prev) => {
          const next = prev.length >= MAX_LOG ? prev.slice(prev.length - MAX_LOG) : prev
          return [...next, entry]
        })
      } else if (e.type === 'task') {
        const t = e.task
        setTasks((prev) => {
          const now = Date.now()
          const current = prev[t.label]
          // A genuine fresh start is a 'start' event with no line AND no progress
          // payload (runAsync); taskProgress updates carry progress/phase and must
          // not reset the accumulated log.
          if (t.status === 'start' && !t.line && t.progress === undefined && t.phase === undefined) {
            // fresh start
            return {
              ...prev,
              [t.label]: {
                label: t.label,
                running: true,
                code: null,
                lines: [],
                updatedAt: now,
                progress: t.progress ?? null,
                phase: t.phase ?? null,
                startedAt: now
              }
            }
          }
          const base =
            current ??
            ({
              label: t.label,
              running: true,
              code: null,
              lines: [],
              updatedAt: now,
              progress: null,
              phase: null,
              startedAt: now
            } satisfies TaskLog)
          const done = t.status === 'end'
          const next: TaskLog = {
            ...base,
            running: !done,
            code: done ? t.code : base.code,
            lines: t.line ? [...base.lines, { stream: t.stream ?? 'stdout', line: t.line }] : base.lines,
            updatedAt: now,
            progress: done ? (t.code === 0 ? 1 : base.progress) : (t.progress ?? base.progress),
            phase: done ? (t.code === 0 ? translate(getLang(), 'task.done') : base.phase) : (t.phase ?? base.phase)
          }
          return { ...prev, [t.label]: next }
        })
      }
    })
    return off
  }, [refresh])

  useEffect(() => {
    const running = Object.values(tasks)
      .filter((t) => t.running)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map((t) => t.label)
    setRunningTasks(running)
  }, [tasks])

  const start = useCallback(async () => {
    const r = await api.start()
    if (!r.ok && r.error) {
      console.error('start failed:', r.error)
      setActionError(r.error)
    }
  }, [])

  const stop = useCallback(async () => {
    await api.stop()
  }, [])

  const restart = useCallback(async () => {
    const r = await api.restart()
    if (!r.ok && r.error) {
      console.error('restart failed:', r.error)
      setActionError(r.error)
    }
  }, [])

  const openUi = useCallback(async () => {
    await api.openUi()
  }, [])

  const dismissError = useCallback(() => setActionError(null), [])

  const saveConfig = useCallback(async (patch: Partial<LauncherConfig>) => {
    const next = await api.setConfig(patch)
    setConfig(next)
  }, [])

  return (
    <HarnessContext.Provider
      value={{
        state,
        log,
        config,
        tasks,
        runningTasks,
        refresh,
        start,
        stop,
        restart,
        openUi,
        saveConfig,
        reloadPlugins,
        actionError,
        dismissError
      }}
    >
      {children}
    </HarnessContext.Provider>
  )
}
