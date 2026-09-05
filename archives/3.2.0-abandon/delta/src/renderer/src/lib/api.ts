import type {
  BalanceData,
  BalanceResult,
  BootstrapState,
  CmdResult,
  DshInstance,
  HarnessState,
  LauncherConfig,
  LauncherEvent,
  LogLine,
  LocalPlugin,
  InstalledPlugin,
  MarketPage,
  MarketReadme,
  MarketRepo,
  McpKv,
  McpServer,
  McpTransport,
  NewInstanceInput,
  PluginCellStatus,
  PluginListResult,
  PluginMatrixColumn,
  PluginMatrixResult,
  PluginMatrixRow,
  PluginMeta,
  PluginSubPackage,
  ProbeStatus,
  RepoSkillInfo,
  SecurityAuditEvent,
  SkillInfo,
  SkillOrigin,
  SkillUpdateInfo,
  SkillsResult,
  SkillMarketRepo,
  SkillRepoCandidate,
  SkillPolicyPatch,
  WebChatConfig,
  SecurityConfig,
  TaskEvent
} from '../../../shared/types'

export type {
  BalanceData,
  BalanceResult,
  BootstrapState,
  CmdResult,
  DshInstance,
  HarnessState,
  LauncherConfig,
  LauncherEvent,
  LogLine,
  LocalPlugin,
  InstalledPlugin,
  MarketPage,
  MarketReadme,
  MarketRepo,
  McpKv,
  McpServer,
  McpTransport,
  NewInstanceInput,
  PluginCellStatus,
  PluginListResult,
  PluginMatrixColumn,
  PluginMatrixResult,
  PluginMatrixRow,
  PluginMeta,
  PluginSubPackage,
  ProbeStatus,
  RepoSkillInfo,
  SecurityAuditEvent,
  SkillInfo,
  SkillOrigin,
  SkillUpdateInfo,
  SkillsResult,
  SkillMarketRepo,
  SkillRepoCandidate,
  SkillPolicyPatch,
  WebChatConfig,
  SecurityConfig,
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
