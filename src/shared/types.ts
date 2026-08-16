// Shared types used by main, preload, and renderer.

export type HarnessStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'external'

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

export type InstallMode = 'source' | 'bundled'

export interface LauncherConfig {
  /** 'source' runs the checked-out harness repo with a system Node; 'bundled' runs the portable runtime. */
  installMode: InstallMode
  /** Directory holding the portable Node runtime + bundled @deepseek-ai/dsh install. */
  runtimeRoot: string
  /** Portable Node version pinned by installRuntime (mirrored from npmmirror). */
  nodeVersion: string
  /** Bundled @deepseek-ai/dsh version pinned by installRuntime / updateRuntime. */
  dshVersion: string
  harnessRepo: string
  /** Remote URL used by the one-click download / update in Settings. */
  harnessRepoUrl: string
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
  /** Abort the boot with an error if the port has not become ready within this many ms. */
  startupTimeoutMs: number
  /** Optional DeepSeek API key override for the balance widget; empty ⇒ read from dsh credentials. */
  deepseekApiKey?: string
  /** API provider presets for one-click switching between AI vendors. */
  apiPresets: ApiPreset[]
  /** Which preset is currently active (its baseUrl is injected into dsh at launch). */
  activeApiPresetId: string
  /** UI + main-process log language. Defaults from the system locale on first run. */
  language: 'zh' | 'en'
  /** Hide to the system tray on window close instead of quitting. */
  closeToTray: boolean
  /** DSH view: replace the collapsed whale rail with a draggable floating orb. Default off. */
  floatingWhale: boolean
  /** How many plugin-market entries are fetched per page (10–50). */
  marketPageSize: number
  /** Optional GitHub personal access token, used to clone private plugin repos. */
  githubToken?: string
}

/** An OpenAI-compatible API vendor preset: model base URL + optional balance endpoint. */
export interface ApiPreset {
  /** Stable identifier, e.g. 'deepseek-official'. */
  id: string
  /** Display name, e.g. 'DeepSeek 官方'. */
  name: string
  /** Model API base URL — injected as DEEPSEEK_BASE_URL when launching dsh. Empty = skip injection. */
  baseUrl: string
  /** Balance endpoint full URL; empty = this vendor has no balance API. */
  balanceUrl: string
  /** Preset-specific API key for the balance widget; takes precedence over the global key. */
  apiKey?: string
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
  /** 0..1 completion when determinable (e.g. file downloads); undefined = indeterminate. */
  progress?: number
  /** Short phase label for the progress UI, e.g. '下载 Node'. */
  phase?: string
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
  /** When a repo ships several plugin packages (e.g. skins in subdirs), the caller can choose one. */
  packages?: PluginSubPackage[]
}

/** A plugin package found inside a cloned repo (the repo root may not be one itself). */
export interface PluginSubPackage {
  /** Repo-relative directory of the package, e.g. 'maid-atelier'. */
  path: string
  /** Package name from its package.json. */
  name: string
}

export interface BalanceData {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
  is_available: boolean
}

export interface BalanceResult {
  ok: boolean
  data?: BalanceData
  error?: string
  /** Display name of the provider the balance came from (for the widget title). */
  provider?: string
}

/** A dsh plugin discovered on GitHub (topic:dsh-plugin), mapped from the search API response. */
export interface MarketRepo {
  id: number
  owner: string
  /** Repository name (without owner), e.g. 'dsh-plugin-xxx'. */
  repo: string
  /** owner/repo */
  fullName: string
  description: string | null
  htmlUrl: string
  cloneUrl: string
  stars: number
  forks: number
  language: string | null
  /** ISO date string of the last push. */
  updatedAt: string
  topics: string[]
  avatarUrl: string
  defaultBranch: string
}

export interface MarketPage {
  ok: boolean
  repos: MarketRepo[]
  totalCount: number
  page: number
  error?: string
}

export interface MarketReadme {
  ok: boolean
  /** Raw markdown of the repository README. */
  text?: string
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
  /** Clone/update the harness repo, install deps, then auto-configure paths. */
  downloadHarness(): Promise<CmdResult>
  /** Clone a plugin from a GitHub repo URL into pluginDir, then install it. An optional repo-relative subdir installs that sub-package (some repos ship plugins in subfolders). */
  downloadPlugin(url: string, subdir?: string): Promise<CmdResult>
  /** Download + unpack the portable runtime (Node, bundled dsh, pnpm) and auto-configure paths. */
  installRuntime(): Promise<CmdResult>
  /** Upgrade only the bundled dsh package inside runtimeRoot; leaves ~/.dsh untouched. */
  updateRuntime(): Promise<CmdResult>
  /** DeepSeek balance for the configured API key. */
  getBalance(): Promise<BalanceResult>
  /** One page of the plugin market: GitHub repos tagged `dsh-plugin`, sorted by stars. An optional keyword is searched server-side. */
  searchMarket(page: number, query?: string): Promise<MarketPage>
  /** Raw markdown of a repository README for the market detail modal. */
  fetchMarketReadme(owner: string, repo: string): Promise<MarketReadme>
  /** Show a confirm dialog for an external link, then open it in the system browser if confirmed. */
  confirmOpenExternal(url: string): Promise<boolean>
  /** Show/hide the embedded DSH view; reload when the harness (re)became ready. */
  setDshActive(active: boolean, reload?: boolean): void
  /** Sync the sidebar width so the DSH view sits flush against it. */
  setDshSidebarWidth(width: number): void
  /** Show/hide the floating whale orb (used while the DSH view is open with floatingWhale enabled). */
  setOrbVisible(visible: boolean): void
  /** The orb page: press start, reporting the pointer offset within the orb view. */
  orbDragStart(ox: number, oy: number): void
  /** The orb page: pointer's absolute screen position while dragging (the view follows it). */
  orbDragMove(sx: number, sy: number): void
  /** The orb page: drag finished (position kept). */
  orbDragEnd(): void
  /** The orb page: short click — return the orb to the top-left and expand the menu. */
  orbClick(): void
  /** Fired when the floating orb is clicked — the launcher should expand its sidebar. */
  onOrbClicked(cb: () => void): () => void
  onEvent(cb: (e: LauncherEvent) => void): () => void
}
