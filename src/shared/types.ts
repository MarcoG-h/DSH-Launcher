// Shared types used by main, preload, and renderer.

export type HarnessStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface HarnessState {
  status: HarnessStatus
  pid: number | null
  profile: string
  port: number
  startedAt: number | null
  ready: boolean
  exitCode: number | null
  lastError: string | null
}

export interface LogLine {
  stream: 'stdout' | 'stderr'
  line: string
  at: number
}

export interface LauncherConfig {
  harnessRepo: string
  dshHome: string
  pluginDir: string
  profile: string
  port: number
  nodePath: string
  /** e.g. ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'] — the dsh profile name is appended at run time. */
  launchArgs: string[]
  buildCmd: string
  stopOnQuit: boolean
  pnpm: string
  /** Open the Web UI in the default browser once the port reports ready. */
  autoOpenUi: boolean
  /** Abort the boot with an error if the port has not become ready within this many ms. */
  startupTimeoutMs: number
}

export interface InstalledPlugin {
  name: string
  version: string
  description: string
  spec: string
  localPath: string | null
  enabled: boolean
  isBundle: boolean
  inBox: boolean
}

export type LocalStatus = 'not-installed' | 'installed' | 'enabled'

export interface LocalPlugin {
  name: string
  version: string
  description: string
  path: string
  isBundle: boolean
  platform: string | null
  status: LocalStatus
}

export interface PluginListResult {
  profile: string
  bundles: string[]
  installed: InstalledPlugin[]
  local: LocalPlugin[]
}

export interface TaskEvent {
  label: string
  status: 'start' | 'end'
  code: number | null
  stream?: 'stdout' | 'stderr'
  line?: string
}

export type LauncherEvent =
  | { type: 'state'; state: HarnessState }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string; at: number }
  | { type: 'task'; task: TaskEvent }

export interface BootstrapState {
  state: HarnessState
  log: LogLine[]
  config: LauncherConfig
}

export interface CmdResult {
  ok: boolean
  code: number | null
  error?: string
}

export interface DshLauncherApi {
  getState(): Promise<BootstrapState>
  start(): Promise<CmdResult>
  stop(): Promise<void>
  restart(): Promise<CmdResult>
  openUi(): Promise<void>
  getConfig(): Promise<LauncherConfig>
  setConfig(patch: Partial<LauncherConfig>): Promise<LauncherConfig>
  listPlugins(): Promise<PluginListResult>
  installPlugin(spec: string): Promise<CmdResult>
  removePlugin(name: string): Promise<CmdResult>
  setPluginEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; changed: boolean; bundles: string[] }>
  repairDeps(): Promise<CmdResult>
  rebuild(): Promise<CmdResult>
  onEvent(cb: (e: LauncherEvent) => void): () => void
}
