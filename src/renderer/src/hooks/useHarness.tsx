import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type DshInstance, type HarnessState, type LauncherConfig, type LauncherEvent, type LogLine, type TaskLog } from '../lib/api'
import { getLang, translate } from '../i18n'

const MAX_LOG = 4000

interface HarnessContextValue {
  /** every instance's state, keyed by instance id */
  states: Record<string, HarnessState>
  /** per-instance log buffers */
  logs: Record<string, LogLine[]>
  /** instance id → true when it runs in a separate (popped-out) child window */
  poppedOut: Record<string, boolean>
  /** all instances (order = sidebar order) */
  instances: DshInstance[]
  /** the instance the UI currently shows */
  activeInstanceId: string
  /** the active instance's state (null before bootstrap) */
  state: HarnessState | null
  /** the active instance's log */
  log: LogLine[]
  config: LauncherConfig | null
  tasks: Record<string, TaskLog>
  /** task labels that are currently running, in start order */
  runningTasks: string[]
  refresh: () => Promise<void>
  /** start/stop/restart/open the *active* instance */
  start: () => Promise<void>
  stop: () => Promise<void>
  restart: () => Promise<void>
  openUi: () => Promise<void>
  /** switch the active instance (persists to config, embedded DSH view follows) */
  setActiveInstance: (id: string) => Promise<void>
  saveConfig: (patch: Partial<LauncherConfig>) => Promise<void>
  reloadPlugins: () => void
  /** error from the last start/stop/restart action, surfaced in the UI */
  actionError: string | null
  dismissError: () => void
  /** 官方 dsh 最新版 vs 当前内置版(启动时后台检查;未查到/未内置时为 null) */
  dshUpdate: { latest: string | null; current: string | null; update: boolean } | null
  /** DSH-Launcher 自身新版 Release 提示(启动时后台检查) */
  launcherUpdate: { latest: string | null; current: string; url: string | null; update: boolean } | null
}

const HarnessContext = createContext<HarnessContextValue | null>(null)

export function useHarness(): HarnessContextValue {
  const ctx = useContext(HarnessContext)
  if (!ctx) throw new Error('useHarness must be used within <HarnessProvider>')
  return ctx
}

export function HarnessProvider({ children }: { children: ReactNode }): ReactNode {
  const [states, setStates] = useState<Record<string, HarnessState>>({})
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})
  const [poppedOut, setPoppedOut] = useState<Record<string, boolean>>({})
  const [instances, setInstances] = useState<DshInstance[]>([])
  const [activeInstanceId, setActiveInstanceId] = useState<string>('')
  const [config, setConfigState] = useState<LauncherConfig | null>(null)
  const [tasks, setTasks] = useState<Record<string, TaskLog>>({})
  const [runningTasks, setRunningTasks] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [dshUpdate, setDshUpdate] = useState<{ latest: string | null; current: string | null; update: boolean } | null>(null)
  const [launcherUpdate, setLauncherUpdate] = useState<{ latest: string | null; current: string; url: string | null; update: boolean } | null>(null)
  const pluginsVersion = useRef(0)

  const reloadPlugins = useCallback(() => {
    pluginsVersion.current += 1
  }, [])

  const applyConfig = useCallback((next: LauncherConfig) => {
    setConfigState(next)
    setInstances(next.instances ?? [])
    setActiveInstanceId(next.activeInstanceId ?? '')
  }, [])

  const refresh = useCallback(async () => {
    try {
      const boot = await api.getState()
      setStates(boot.states)
      setLogs(boot.logs)
      applyConfig(boot.config)
    } catch {
      /* ignore */
    }
  }, [applyConfig])

  useEffect(() => {
    void refresh()
    const off = api.onEvent((e: LauncherEvent) => {
      if (e.type === 'state') {
        setStates((prev) => ({ ...prev, [e.state.instanceId]: e.state }))
      } else if (e.type === 'log') {
        const entry: LogLine = { stream: e.stream, line: e.line, at: e.at }
        setLogs((prev) => {
          const cur = prev[e.instanceId] ?? []
          const next = cur.length >= MAX_LOG ? cur.slice(cur.length - MAX_LOG) : cur
          return { ...prev, [e.instanceId]: [...next, entry] }
        })
      } else if (e.type === 'instances') {
        setInstances(e.instances)
        setActiveInstanceId(e.activeInstanceId)
      } else if (e.type === 'popup') {
        setPoppedOut((prev) => ({ ...prev, [e.instanceId]: e.open }))
      } else if (e.type === 'dsh-update') {
        setDshUpdate({ latest: e.latest, current: e.current, update: e.latest !== null && e.current !== null && e.latest !== e.current })
      } else if (e.type === 'launcher-update') {
        setLauncherUpdate({ latest: e.latest, current: e.current, url: e.url, update: e.update })
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
  }, [refresh, applyConfig])

  useEffect(() => {
    const running = Object.values(tasks)
      .filter((t) => t.running)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .map((t) => t.label)
    setRunningTasks(running)
  }, [tasks])

  // The active instance's state/log are derived so consumers that only look at
  // `state`/`log` keep working; switching instances just changes the lookup key.
  const state = activeInstanceId ? (states[activeInstanceId] ?? null) : null
  const log = activeInstanceId ? (logs[activeInstanceId] ?? []) : []

  const start = useCallback(async () => {
    if (!activeInstanceId) return
    const r = await api.startInstance(activeInstanceId)
    if (!r.ok && r.error) {
      console.error('start failed:', r.error)
      setActionError(r.error)
    }
  }, [activeInstanceId])

  const stop = useCallback(async () => {
    if (!activeInstanceId) return
    await api.stopInstance(activeInstanceId)
  }, [activeInstanceId])

  const restart = useCallback(async () => {
    if (!activeInstanceId) return
    const r = await api.restartInstance(activeInstanceId)
    if (!r.ok && r.error) {
      console.error('restart failed:', r.error)
      setActionError(r.error)
    }
  }, [activeInstanceId])

  const openUi = useCallback(async () => {
    await api.openUi()
  }, [])

  const setActiveInstance = useCallback(async (id: string) => {
    const next = await api.setActiveInstance(id)
    applyConfig(next)
  }, [applyConfig])

  const dismissError = useCallback(() => setActionError(null), [])

  const saveConfig = useCallback(async (patch: Partial<LauncherConfig>) => {
    const next = await api.setConfig(patch)
    applyConfig(next)
  }, [applyConfig])

  return (
    <HarnessContext.Provider
      value={{
        states,
        logs,
        poppedOut,
        instances,
        activeInstanceId,
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
        setActiveInstance,
        saveConfig,
        reloadPlugins,
        actionError,
        dismissError,
        dshUpdate,
        launcherUpdate
      }}
    >
      {children}
    </HarnessContext.Provider>
  )
}
