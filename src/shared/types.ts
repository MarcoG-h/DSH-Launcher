// Shared types used by main, preload, and renderer.

export type HarnessStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'external'

export interface HarnessState {
  /** The instance this state belongs to. */
  instanceId: string
  status: HarnessStatus
  pid: number | null
  profile: string
  port: number
  startedAt: number | null
  ready: boolean
  exitCode: number | null
  lastError: string | null
  /** 插件集已改动,需手动重启实例后才生效。 */
  pendingRestart: boolean
}

export interface LogLine {
  stream: 'stdout' | 'stderr'
  line: string
  at: number
}

export type InstallMode = 'source' | 'bundled'

/** One independently-running DSH: its own profile, port, and session workspace. */
export interface DshInstance {
  /** Stable id (uuid). */
  id: string
  /** User-visible name, e.g. "工作实例". */
  name: string
  /** dsh profile this instance boots (`web`, or a custom profile name). */
  profile: string
  /** Port for `--port`; 0 lets the OS pick a free one (parsed from dsh's log at start). */
  port: number
  /** Start this instance automatically when the launcher boots. */
  autoStart: boolean
  /** User-set note shown on the instance card. */
  description: string
  /** Show the instance in the sidebar / dashboard / plugin matrix. Disabled ones stay configured but hidden. */
  enabled: boolean
  /** Process working directory — isolates this instance's session list (sessions are keyed by cwd). */
  workspace?: string
  /** 独立 DSH_HOME(创建时固定为 join(runtimeRoot, 'homes', id),不可后续修改);缺省 = 共享 cfg.dshHome。 */
  dshHome?: string
}

/** Per-plugin user metadata (display-name override + remark), keyed by package name. */
export interface PluginMeta {
  /** Overrides the plugin's displayed name in the launcher UI; empty = use the package name. */
  displayName?: string
  /** Free-text remark shown under the plugin name. */
  remark?: string
}

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
  /** The active instance's profile (mirror of instances[active].profile). */
  profile: string
  /** The active instance's port (mirror of instances[active].port). */
  port: number
  nodePath: string
  /** e.g. ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'] — the dsh profile name is appended at run time. */
  launchArgs: string[]
  buildCmd: string
  stopOnQuit: boolean
  pnpm: string
  /** Abort the boot with an error if the port has not become ready within this many ms. */
  startupTimeoutMs: number
  /** UI + main-process log language. Defaults from the system locale on first run. */
  language: 'zh' | 'en'
  /** Hide to the system tray on window close instead of quitting. */
  closeToTray: boolean
  /** Startup splash: play the whale-lightbulb animation before showing the window. Default on. */
  splashEnabled: boolean
  /** Launch: auto-start the active instance on app start. Default off; flips on automatically after a successful deploy. */
  autoStartOnLaunch: boolean
  /** DSH view: replace the collapsed whale rail with a draggable floating orb. Default off. */
  floatingWhale: boolean
  /** How many plugin-market entries are fetched per page (10–50). */
  marketPageSize: number
  /** 插件市场当前来源,持久化(见 shared/plugin-sources.ts)。 */
  marketSource?: MarketSourceId
  /** Optional GitHub personal access token, used to clone private plugin repos. */
  githubToken?: string
  /** All DSH instances. Migration turns the legacy single profile/port into one instance. */
  instances: DshInstance[]
  /** The instance whose state/view the UI currently shows. */
  activeInstanceId: string
  /** Per-plugin user metadata (display-name override + remark), keyed by package name. */
  pluginMeta?: Record<string, PluginMeta>
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

/** Two-state plugin status: a plugin is either enabled for an instance or absent from it. */
export type LocalStatus = 'not-installed' | 'enabled'

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

/** Plugin×instance matrix: rows are local plugins, columns are instances. */
export type PluginCellStatus = 'not-installed' | 'enabled'

export interface PluginMatrixColumn {
  id: string
  name: string
  profile: string
  running: boolean
}

export interface PluginMatrixRow {
  /** Package name (stable key). */
  name: string
  /** Display name — pluginMeta override or the package name. */
  displayName: string
  version: string
  description: string
  /** User remark (pluginMeta); empty when none. */
  remark: string
  /** 本地库源码目录。空字符串 = 未在本地库、由 `dsh plugin add` 直装进某实例(见 spec)。 */
  path: string
  isBundle: boolean
  platform: string | null
  /** 直装行(未在本地库)的安装 spec(github:owner/repo 或 npm 包名);本地库行为空串。 */
  spec: string
}

export interface PluginMatrixResult {
  rows: PluginMatrixRow[]
  columns: PluginMatrixColumn[]
  /** row name → instance id → status. */
  cells: Record<string, Record<string, PluginCellStatus>>
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
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string; at: number; instanceId: string }
  | { type: 'task'; task: TaskEvent }
  | { type: 'instances'; instances: DshInstance[]; activeInstanceId: string }
  | { type: 'popup'; instanceId: string; open: boolean }
  | { type: 'dsh-update'; latest: string | null; current: string | null }
  | { type: 'launcher-update'; latest: string | null; current: string; url: string | null; update: boolean }

export interface BootstrapState {
  /** state per instance id. */
  states: Record<string, HarnessState>
  /** log per instance id. */
  logs: Record<string, LogLine[]>
  config: LauncherConfig
}

export interface CmdResult {
  ok: boolean
  code: number | null
  error?: string
  /** Tail of the child process's stderr (last ~8k chars), for diagnosing failures. */
  stderr?: string
  /** When a repo ships several plugin packages (e.g. skins in subdirs), the caller can choose one. */
  packages?: PluginSubPackage[]
  /** Instance ids affected by a cross-instance operation (e.g. removeFromLibrary). */
  affected?: string[]
  /** Non-fatal notes from a multi-step operation (e.g. a bundle install that skipped a plugin). */
  warnings?: string[]
  /** installBundle:失败插件的安装 spec 列表,一键重试时原样传回 installBundle(bundleId, specs)。 */
  bundleFailed?: string[]
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
}

/** 插件市场来源:GitHub topic 搜索 / deepseek1024.com / dshfind.com。 */
export type MarketSourceId = 'github' | 'dsh1024' | 'dshfind'

/** 某源的分类项(与服务端格式无关的归一化形态;id='all' 为「全部」)。 */
export interface SourceCategory {
  id: string
  zhName: string
  enName: string
  count?: number
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
  /** 来源源 id(卡片/弹窗据此分支展示;GitHub 源不填)。 */
  source?: MarketSourceId
  /** 源B:近 30 天安装量。 */
  installs30d?: number
  /** 源C:质量评分(0-100)。 */
  score?: number
  /** 源C:风险标记。 */
  isRisky?: boolean
  /** 源C:风险说明。 */
  riskNote?: string
  /** 源C:仓库已归档。 */
  archived?: boolean
  /** 源B:从 install 命令解析出的子包路径(下载时作为 subdir 提示)。 */
  subdirHint?: string
}

export interface MarketPage {
  ok: boolean
  repos: MarketRepo[]
  totalCount: number
  page: number
  /** 该源实际每页条数(源B 服务端固定 100/页,忽略 per_page 参数);缺省时用配置的 marketPageSize。 */
  pageSize?: number
  error?: string
  /** 源B/源C 的分类列表(含计数);GitHub 源不填,渲染层直接用 MARKET_CATEGORIES。 */
  categories?: SourceCategory[]
}

export interface MarketReadme {
  ok: boolean
  /** Raw markdown of the repository README. */
  text?: string
  error?: string
}

/** Input for creating a new DSH instance. */
export interface NewInstanceInput {
  name: string
  profile: string
  port: number
  autoStart: boolean
  /** User-set note shown on the instance card. */
  description?: string
  /** 'isolated' = 新建独立 DSH_HOME(复制所选 home 的 .credentials.yaml);缺省 'shared'(共享到 home 字段指定的 home)。 */
  homeMode?: 'shared' | 'isolated'
  /** homeMode='shared' 时的共享目标 home 路径;缺省 = 全局 cfg.dshHome(现状行为)。isolated 时忽略。 */
  home?: string
}

/** 整合包安装选项:新建实例的数据目录选择 + 失败插件重试清单。 */
export interface BundleInstallOptions {
  /** 'isolated' = 为整合包新建独立 DSH_HOME;缺省 'shared'(共享到 home 字段指定的 home)。 */
  homeMode?: 'shared' | 'isolated'
  /** homeMode='shared' 时的共享目标 home 路径;缺省 = 全局 cfg.dshHome。 */
  home?: string
  /** 上次安装失败的插件 spec 清单(bundleFailed):只重装这些,跳过建实例与成功项。 */
  retrySpecs?: string[]
}

/**
 * A plugin that ships with a recommended bundle (整合包). 有公开源,安装时用
 * `dsh plugin add <spec>` 直装最新版;`name` 仅用于展示。
 */
export interface BundlePlugin {
  /** 展示名(去掉 scope / dsh- 前缀后更易读)。 */
  name?: string
  /** `dsh plugin add <spec>` 的源:npm 包名或 `github:owner/repo`。 */
  spec?: string
  /** 插件的中文功能简介(详情弹窗展示)。 */
  description?: string
  /** 额外透传给 `dsh plugin add` 的参数(原样追加,用于绕过不可满足的 peer 依赖等)。 */
  flags?: string[]
}

/**
 * A recommended bundle (整合包):社区插件组合已固化在 shared/bundles.ts。
 * 下载时新建实例,并逐个 `dsh plugin add` 直装最新版。
 */
export interface RecommendedBundle {
  id: string
  name: string
  description: string
  /** Base name for the new instance's profile (defaults to `web`). */
  profileBase?: string
  /** 社区插件 —— 计入数量,安装时逐个 `dsh plugin add` 直装。 */
  community: BundlePlugin[]
}

export interface DshLauncherApi {
  getState(): Promise<BootstrapState>
  /** Start one instance (idle/external → running). */
  startInstance(instanceId: string): Promise<CmdResult>
  /** Stop one instance. */
  stopInstance(instanceId: string): Promise<void>
  /** Stop then start one instance. */
  restartInstance(instanceId: string): Promise<CmdResult>
  /** Switch the UI's active instance and show its embedded DSH view. */
  setActiveInstance(instanceId: string): Promise<LauncherConfig>
  /** Create a new instance and return the new config. */
  addInstance(input: NewInstanceInput): Promise<LauncherConfig>
  /** Rename / re-profile / re-port / toggle autoStart of an instance. */
  updateInstance(instanceId: string, patch: Partial<DshInstance>): Promise<LauncherConfig>
  /** Delete an instance (refuses the last one). */
  removeInstance(instanceId: string): Promise<LauncherConfig>
  /** Open the instance's DSH Web UI in the system browser. Optional instance id; defaults to the active instance. */
  openUi(instanceId?: string): Promise<void>
  /** Open the instance's DSH Web UI in a launcher child window (multi-screen), focusing it if already open. */
  openInstanceWindow(instanceId: string): Promise<void>
  /** Close the instance's separate window, popping it back into the embedded launcher view. */
  closeInstanceWindow(instanceId: string): Promise<void>
  getConfig(): Promise<LauncherConfig>
  setConfig(patch: Partial<LauncherConfig>): Promise<LauncherConfig>
  /** Plugin list for the active instance (installed + local). */
  listPlugins(): Promise<PluginListResult>
  /** The plugin×instance matrix for the local-plugins page. */
  listPluginMatrix(): Promise<PluginMatrixResult>
  /** Persist a plugin's display-name override / remark. */
  setPluginMeta(name: string, meta: PluginMeta): Promise<void>
  /** Install a plugin into an instance's profile and enable it. `name` (the package name) is passed by the matrix so enablement is explicit; when omitted, the newly-added dependency is enabled automatically. */
  installPlugin(instanceId: string, spec: string, name?: string): Promise<CmdResult>
  /** Uninstall a plugin from an instance's profile (removes it from both dependencies and bundles). */
  disablePlugin(instanceId: string, name: string): Promise<CmdResult>
  /** Reinstall/update an installed plugin (git pull + reinstall for `file:` plugins, `dsh plugin up` otherwise). */
  updatePlugin(instanceId: string, name: string): Promise<CmdResult>
  /** Remove a plugin from the local library entirely: delete its source folder and uninstall it from every instance. */
  removeFromLibrary(name: string): Promise<CmdResult>
  /** Remove several plugins from the local library in one go (批量删除本地插件): delete each source folder and uninstall it from every instance. */
  removeFromLibraryMany(names: string[]): Promise<CmdResult>
  repairDeps(): Promise<CmdResult>
  rebuild(): Promise<CmdResult>
  /** Clone/update the harness repo, install deps, then auto-configure paths. */
  downloadHarness(): Promise<CmdResult>
  /** Clone a plugin from a GitHub repo URL into pluginDir, then install it into an instance's profile. An optional repo-relative subdir installs that sub-package (some repos ship plugins in subfolders). */
  downloadPlugin(url: string, subdir?: string, instanceId?: string): Promise<CmdResult>
  /** Download a recommended bundle (整合包): create the instance and `dsh plugin add` each community plugin into its profile. Options: `homeMode`/`home` pick the new instance's data directory (shared target or a fresh isolated DSH_HOME); `retrySpecs` (previous `bundleFailed`) re-installs only the failed plugins into the existing instance. */
  installBundle(bundleId: string, options?: BundleInstallOptions): Promise<CmdResult>
  /** Download + unpack the portable runtime (Node, bundled dsh, pnpm) and auto-configure paths. */
  installRuntime(): Promise<CmdResult>
  /** Upgrade only the bundled dsh package inside runtimeRoot; leaves ~/.dsh untouched. */
  updateRuntime(): Promise<CmdResult>
  /** DeepSeek balance for the configured API key. */
  getBalance(): Promise<BalanceResult>
  /** One page of the plugin market: GitHub repos tagged `dsh-plugin`, sorted by stars. An optional keyword and an optional category id (see shared/market-categories.ts) are combined server-side with GitHub search qualifiers. */
  searchMarket(sourceId: MarketSourceId, page: number, query?: string, categoryId?: string, force?: boolean): Promise<MarketPage>
  /** Raw markdown of a repository README for the market detail modal. */
  fetchMarketReadme(owner: string, repo: string): Promise<MarketReadme>
  /** Show a confirm dialog for an external link, then open it in the system browser if confirmed. */
  confirmOpenExternal(url: string): Promise<boolean>
  /** Show/hide the embedded DSH view for an instance; reload when the harness (re)became ready. */
  setDshActive(instanceId: string, active: boolean, reload?: boolean): void
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
