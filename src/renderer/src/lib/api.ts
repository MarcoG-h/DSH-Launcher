import type {
  ApiPreset,
  BalanceData,
  BalanceResult,
  BootstrapState,
  CmdResult,
  HarnessState,
  LauncherConfig,
  LauncherEvent,
  LogLine,
  LocalPlugin,
  InstalledPlugin,
  MarketPage,
  MarketReadme,
  MarketRepo,
  PluginListResult,
  TaskEvent
} from '../../../shared/types'

export type {
  ApiPreset,
  BalanceData,
  BalanceResult,
  BootstrapState,
  CmdResult,
  HarnessState,
  LauncherConfig,
  LauncherEvent,
  LogLine,
  LocalPlugin,
  InstalledPlugin,
  MarketPage,
  MarketReadme,
  MarketRepo,
  PluginListResult,
  TaskEvent
}

export interface TaskLog {
  label: string
  running: boolean
  code: number | null
  lines: { stream: 'stdout' | 'stderr'; line: string }[]
  updatedAt: number
  /** 0..1 when determinable, null = indeterminate */
  progress: number | null
  /** short phase label, e.g. '下载 Node' */
  phase: string | null
  startedAt: number
}

export const api = window.dshLauncher
