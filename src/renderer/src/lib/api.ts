import type {
  BootstrapState,
  CmdResult,
  HarnessState,
  LauncherConfig,
  LauncherEvent,
  LogLine,
  LocalPlugin,
  InstalledPlugin,
  PluginListResult,
  TaskEvent
} from '../../../shared/types'

export type {
  BootstrapState,
  CmdResult,
  HarnessState,
  LauncherConfig,
  LauncherEvent,
  LogLine,
  LocalPlugin,
  InstalledPlugin,
  PluginListResult,
  TaskEvent
}

export interface TaskLog {
  label: string
  running: boolean
  code: number | null
  lines: { stream: 'stdout' | 'stderr'; line: string }[]
  updatedAt: number
}

export const api = window.dshLauncher
