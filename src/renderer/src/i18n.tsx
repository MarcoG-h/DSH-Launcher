// Renderer i18n: flat message dictionary keyed by language. Chinese values are
// copied verbatim from the previous hard-coded UI; English is provided for
// non-Chinese users. The single source of truth for the language is
// LauncherConfig.language, kept in sync by the I18nProvider below.

import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { useHarness } from './hooks/useHarness'

export type Lang = 'zh' | 'en'

type Params = Record<string, string | number>

const zh: Record<string, string> = {
  // nav (App / Sidebar)
  'nav.dsh': 'DSH 界面',
  'nav.dashboard': '控制台',
  'nav.plugins': '第三方插件管理',
  'nav.settings': '设置',
  // status
  'status.stopped': '已停止',
  'status.starting': '启动中',
  'status.running': '运行中',
  'status.stopping': '停止中',
  'status.error': '异常',
  'status.external': '外部运行中',
  'status.unknown': '未知',
  // task
  'task.done': '完成',
  'task.running.pre': '执行中',
  'task.doneExit': '完成 (exit 0)',
  'task.failedExit': '失败 (exit {code})',
  'task.waiting': '等待输出…',
  'task.noOutput': '无输出',
  // sidebar footer
  'sidebar.tasksRunning': '{count} 个任务进行中',
  'sidebar.switchLight': '切换到浅色',
  'sidebar.switchDark': '切换到深色',
  'sidebar.expand': '展开侧边栏',
  'sidebar.collapse': '折叠侧边栏',
  'sidebar.portLabel': '· 端口',
  'sidebar.switchLang': '切换语言',
  // log console
  'log.title': '启动日志 · 实时输出',
  'log.clear': '清空',
  'log.autoScroll': '自动滚动',
  'log.autoScrollOn': '自动滚动 ✓',
  'log.empty': '暂无日志 — 点击「启动」开始运行 dsh。',
  // balance
  'balance.title': '余额',
  'balance.available': '可用',
  'balance.unavailable': '不可用',
  'balance.switchTitle': '切换 API 厂商(重启 dsh 后注入新地址)',
  'balance.refreshTitle': '刷新余额',
  'balance.refreshing': '刷新中…',
  'balance.refresh': '刷新',
  'balance.fetchFailed': '获取余额失败',
  'balance.total': '总额',
  'balance.granted': '赠送',
  'balance.toppedUp': '充值',
  'balance.loading': '加载中…',
  // dashboard
  'dashboard.starting': '启动中…',
  'dashboard.start': '启动',
  'dashboard.stopping': '停止中…',
  'dashboard.stopExternal': '停止(外部)',
  'dashboard.stop': '停止',
  'dashboard.restarting': '重启中…',
  'dashboard.restart': '重启',
  'dashboard.openUi': '打开 Web UI',
  'dashboard.externalNotice': '检测到外部实例在运行 — 点「停止」将其终止后,即可由本应用接管启动。',
  'dashboard.lastError': '上次错误:',
  'dashboard.footer': '启动与停止均会控制 dsh 进程树;窗口关闭时按设置决定是否随应用退出。',
  'meta.pid': '进程 PID',
  'meta.port': '端口',
  'meta.uptime': '运行时长',
  'meta.ready': '就绪',
  'meta.readyYes': '✔ 是',
  'meta.exitCode': '退出码',
  'meta.dataDir': '数据目录',
  // plugins
  'plugins.title': '第三方插件管理',
  'plugins.installLabel': '安装插件 — GitHub 仓库地址 / 本地路径 / npm 包名',
  'plugins.downloadInstall': '下载并安装',
  'plugins.install': '安装',
  'plugins.ghHint.pre': '将以 GitHub 方式克隆到',
  'plugins.ghHint.tail': '并安装到 profile {profile}。',
  'plugins.specHint.pre': '支持',
  'plugins.specHint.sep': '、',
  'plugins.specHint.tail': '、本地路径或 npm 包名。',
  'plugins.installedTitle': '已安装 · {count}',
  'plugins.noInstalled': '该 profile 还没有安装外部插件。',
  'plugins.enabled': '已启用',
  'plugins.disabled': '未启用',
  'plugins.noBundle': '无 bundle',
  'plugins.disable': '停用',
  'plugins.enable': '启用',
  'plugins.uninstall': '卸载',
  'plugins.uninstallTitle': '卸载插件',
  'plugins.confirmRemove': '卸载插件 {name}?',
  'plugins.localTitle': '本地可用 · {count}',
  'plugins.noLocal': '未在插件目录发现插件({dir})。',
  'plugins.installedNotEnabled': '已安装 · 未启用',
  'plugins.notInstalled': '未安装',
  // settings
  'settings.title': '设置',
  'settings.dshTitle': 'DSH 下载 / 更新',
  'settings.systemTitle': '系统管理',
  'settings.language': '界面语言',
  'settings.langZh': '中文',
  'settings.langEn': 'English',
  'settings.closeToTray': '点击关闭按钮时最小化到系统托盘,后台继续运行',
  'settings.floatingWhale': '进入 DSH 界面时使用悬浮球(鲸鱼),左侧不保留侧栏',
  'settings.marketPageSize': '插件市场每页显示数量(10-50)',
  'settings.githubToken': 'GitHub 访问令牌(可选)',
  'settings.githubTokenHint': '用于下载私有插件仓库;公开仓库不需要。留空则匿名克隆。',
  'settings.offlineTitle': '快速离线部署',
  'settings.offlineDesc.pre': '一键装好便携 Node + npm + pnpm + ',
  'settings.offlineDesc.mid': ',部署完成后即可',
  'settings.offlineDesc.bold': '直接启动使用 dsh',
  'settings.offlineDesc.tail': '——目标机器无需安装 Node.js、无需 源码,全程离线可用。这是给普通使用者的推荐方式。',
  'settings.currentMode': '当前模式:',
  'settings.modeBundled': '内置运行环境 · 免装 Node',
  'settings.modeSource': '源码版 · 使用本机 Node',
  'settings.updateNote.pre': '「更新内置 dsh」只升级内置配套插件,不会覆盖',
  'settings.updateNote.mid': '里的第三方插件与',
  'settings.updateNote.tail': '手动条目。',
  'settings.deployBtn': '快速离线部署',
  'settings.deploying': '部署中…',
  'settings.updateBtn': '更新内置 dsh',
  'settings.updating': '更新中…',
  'settings.deployDone': '✔ 部署完成 — 已自动切换为内置模式并回填路径,回到「控制台」点击启动即可直接使用 dsh。',
  'settings.diskNote': '注意:runtimeRoot 与 DSH_HOME 需位于同一磁盘(内置插件通过 junction 链接)。当前 runtimeRoot =',
  'settings.sourceTitle': '⚠ 源码版:下载 / 更新 Harness 源码(高级 — 不建议新手使用)',
  'settings.sourceDesc': '仅当你需要调试或改动 Harness 源码时才点这里。普通使用请用上面的「快速离线部署」,不需要源码。',
  'settings.sourceDesc2.pre': '会克隆 / 更新',
  'settings.sourceDesc2.to': '到',
  'settings.sourceDesc2.mid': '并安装依赖、自动配置路径。需要本机已有 Node 与 pnpm; 若目录已存在则执行',
  'settings.sourceDesc2.tail': '。',
  'settings.downloadBtn': '下载 / 更新源码',
  'settings.downloading': '下载中…',
  'settings.downloadDone': '✔ 完成 — 路径已自动配置。',
  'settings.pathsTitle': '路径与启动',
  'settings.runMode': '运行模式',
  'settings.modeOptionBundled': '内置运行环境(免装 Node)',
  'settings.modeOptionSource': '源码版(本机 Node + 源码仓库)',
  'settings.runtimeRoot': '运行环境目录 runtimeRoot',
  'settings.runtimeRootHint': '便携 Node + 内置 dsh 的安装位置',
  'settings.harnessRepo': 'Harness 仓库',
  'settings.harnessRepoHint': 'dsh CLI 源码所在目录(源码版用)',
  'settings.harnessRepoUrl': 'Harness 仓库 URL',
  'settings.harnessRepoUrlHint': '一键下载 / 更新源码时使用的克隆地址',
  'settings.dshHome': 'DSH_HOME',
  'settings.dshHomeHint': 'profiles/sessions/storages 所在目录',
  'settings.pluginDir': '本地插件目录',
  'settings.pluginDirHint': '扫描可用插件的目录(如 DSH-Plugin)',
  'settings.deepseekApiKey': 'DeepSeek API Key(可选)',
  'settings.deepseekApiKeyHint': '余额小部件专用;留空则读取 ~/.dsh/.credentials.yaml',
  'settings.port': '端口',
  'settings.profile': 'profile',
  'settings.profileHint': '启动的 profile 名(默认 web)',
  'settings.nodePath': 'node 可执行文件',
  'settings.launchArgs': '启动命令(launchArgs,空格分隔)',
  'settings.launchArgsHint': '最终:',
  'settings.buildCmd': '构建命令',
  'settings.pnpm': 'pnpm 可执行文件',
  'settings.stopOnQuit': '关闭应用时停止 Harness 进程',
  'settings.startupTimeout': '启动超时(毫秒)',
  'settings.saved': '已保存 ✓',
  'settings.save': '保存设置',
  'settings.autoSavedHint': '系统设置修改后自动保存,无需手动保存。',
  'settings.apiTitle': 'API 切换',
  'settings.apiDesc': '在多个 AI 厂商预设之间一键切换。切换后需重启 dsh 生效 —— 启动时会自动注入该厂商的地址和 API Key(同时用于余额查询),无需再去 DSH 界面填。预设没填 Key 时,沿用',
  'settings.apiDesc.tail': ' 里已有的。',
  'settings.noPresets': '暂无预设,点击下方「添加预设」创建一个。',
  'settings.presetNamePlaceholder': '厂商名称',
  'settings.current': '当前',
  'settings.setActive': '设为当前',
  'settings.delete': '删除',
  'settings.baseUrl': '模型 API 地址 (baseUrl)',
  'settings.balanceUrl': '余额接口 (balanceUrl,可留空)',
  'settings.apiKey': 'API Key(注入 dsh 供模型调用 + 余额查询)',
  'settings.addPreset': '添加预设',
  'settings.newPresetName': '新厂商',
  'settings.maintenanceTitle': '维护(源码版)',
  'settings.maintenanceDesc.pre': '依赖缺失(如上次的',
  'settings.maintenanceDesc.tail': ' 报错)或源码改动后,需要先在仓库内重新安装 / 构建,再启动。',
  'settings.repair': '修复依赖 (pnpm install)',
  'settings.rebuild': '重新构建 (pnpm run build)',
  // plugins page — local / market tabs
  'plugins.tabLocal': '本地插件',
  'plugins.tabMarket': '插件市场',
  // plugin market
  'market.searchPlaceholder': '搜索插件(名称 / 描述)…',
  'market.refresh': '刷新',
  'market.loading': '正在加载插件市场…',
  'market.empty': '未找到相关插件。',
  'market.error': '加载失败:',
  'market.total': '共 {count} 个插件',
  'market.updated': '更新于 {date}',
  'market.install': '安装',
  'market.installed': '已安装',
  'market.multiPackage': '该仓库包含多个插件包,请选择要安装的:',
  'market.installSub': '安装子包',
  'market.details': '查看详情',
  'market.readmeTitle': 'README',
  'market.readmeLoading': '正在加载 README…',
  'market.noReadme': '该仓库没有 README。',
  'market.close': '关闭',
  'market.pagePrev': '上一页',
  'market.pageNext': '下一页',
  'market.pageOf': '第 {page} / {pages} 页',
  'market.readmeFailed': '加载 README 失败。'
}

const en: Record<string, string> = {
  'nav.dsh': 'DSH View',
  'nav.dashboard': 'Dashboard',
  'nav.plugins': 'Third-Party Plugin Management',
  'nav.settings': 'Settings',
  'status.stopped': 'Stopped',
  'status.starting': 'Starting',
  'status.running': 'Running',
  'status.stopping': 'Stopping',
  'status.error': 'Error',
  'status.external': 'External',
  'status.unknown': 'Unknown',
  'task.done': 'Done',
  'task.running.pre': 'Running',
  'task.doneExit': 'Done (exit 0)',
  'task.failedExit': 'Failed (exit {code})',
  'task.waiting': 'Waiting for output…',
  'task.noOutput': 'No output',
  'sidebar.tasksRunning': '{count} task(s) running',
  'sidebar.switchLight': 'Switch to light',
  'sidebar.switchDark': 'Switch to dark',
  'sidebar.expand': 'Expand sidebar',
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.portLabel': '· port',
  'sidebar.switchLang': 'Switch language',
  'log.title': 'Startup Log · Live Output',
  'log.clear': 'Clear',
  'log.autoScroll': 'Auto-scroll',
  'log.autoScrollOn': 'Auto-scroll ✓',
  'log.empty': 'No logs yet — click "Start" to run dsh.',
  'balance.title': 'Balance',
  'balance.available': 'Available',
  'balance.unavailable': 'Unavailable',
  'balance.switchTitle': 'Switch API provider (injected after restarting dsh)',
  'balance.refreshTitle': 'Refresh balance',
  'balance.refreshing': 'Refreshing…',
  'balance.refresh': 'Refresh',
  'balance.fetchFailed': 'Failed to fetch balance',
  'balance.total': 'Total',
  'balance.granted': 'Granted',
  'balance.toppedUp': 'Topped-up',
  'balance.loading': 'Loading…',
  'dashboard.starting': 'Starting…',
  'dashboard.start': 'Start',
  'dashboard.stopping': 'Stopping…',
  'dashboard.stopExternal': 'Stop (external)',
  'dashboard.stop': 'Stop',
  'dashboard.restarting': 'Restarting…',
  'dashboard.restart': 'Restart',
  'dashboard.openUi': 'Open Web UI',
  'dashboard.externalNotice': 'An external instance is running — click "Stop" to terminate it, then this app can take over.',
  'dashboard.lastError': 'Last error:',
  'dashboard.footer': 'Start and stop control the dsh process tree; whether it exits with the app on window close follows the setting.',
  'meta.pid': 'Process PID',
  'meta.port': 'Port',
  'meta.uptime': 'Uptime',
  'meta.ready': 'Ready',
  'meta.readyYes': '✔ Yes',
  'meta.exitCode': 'Exit code',
  'meta.dataDir': 'Data directory',
  'plugins.title': 'Third-Party Plugin Management',
  'plugins.installLabel': 'Install plugin — GitHub repo URL / local path / npm package name',
  'plugins.downloadInstall': 'Download & Install',
  'plugins.install': 'Install',
  'plugins.ghHint.pre': 'Will clone via GitHub into',
  'plugins.ghHint.tail': 'and install into profile {profile}.',
  'plugins.specHint.pre': 'Supports',
  'plugins.specHint.sep': ', ',
  'plugins.specHint.tail': ', a local path, or an npm package name.',
  'plugins.installedTitle': 'Installed · {count}',
  'plugins.noInstalled': 'This profile has no external plugins installed yet.',
  'plugins.enabled': 'Enabled',
  'plugins.disabled': 'Not enabled',
  'plugins.noBundle': 'No bundle',
  'plugins.disable': 'Disable',
  'plugins.enable': 'Enable',
  'plugins.uninstall': 'Uninstall',
  'plugins.uninstallTitle': 'Uninstall plugin',
  'plugins.confirmRemove': 'Uninstall plugin {name}?',
  'plugins.localTitle': 'Available Locally · {count}',
  'plugins.noLocal': 'No plugins found in the plugin directory ({dir}).',
  'plugins.installedNotEnabled': 'Installed · Not enabled',
  'plugins.notInstalled': 'Not installed',
  'settings.title': 'Settings',
  'settings.dshTitle': 'DSH Download / Update',
  'settings.systemTitle': 'System',
  'settings.language': 'Interface language',
  'settings.langZh': '中文',
  'settings.langEn': 'English',
  'settings.closeToTray': 'Minimize to system tray on close (keep running in the background)',
  'settings.floatingWhale': 'In the DSH view, use a floating whale orb (no sidebar rail on the left)',
  'settings.marketPageSize': 'Plugins shown per page in the market (10-50)',
  'settings.githubToken': 'GitHub access token (optional)',
  'settings.githubTokenHint': 'For cloning private plugin repos; public repos don’t need it. Leave empty for anonymous clone.',
  'settings.offlineTitle': 'Quick Offline Deployment',
  'settings.offlineDesc.pre': 'Installs a portable Node + npm + pnpm + ',
  'settings.offlineDesc.mid': ', and once deployed you can',
  'settings.offlineDesc.bold': 'start and use dsh directly',
  'settings.offlineDesc.tail': ' — the target machine needs no Node.js and no source; it works fully offline. This is the recommended way for regular users.',
  'settings.currentMode': 'Current mode:',
  'settings.modeBundled': 'Bundled runtime · no Node needed',
  'settings.modeSource': 'Source build · uses system Node',
  'settings.updateNote.pre': '“Update built-in dsh” only upgrades the bundled companion plugins — it won’t overwrite',
  'settings.updateNote.mid': 'third-party plugins in',
  'settings.updateNote.tail': 'manual entries.',
  'settings.deployBtn': 'Quick Offline Deployment',
  'settings.deploying': 'Deploying…',
  'settings.updateBtn': 'Update built-in dsh',
  'settings.updating': 'Updating…',
  'settings.deployDone': '✔ Deployment complete — switched to bundled mode and back-filled paths automatically; go to Dashboard and click Start to use dsh.',
  'settings.diskNote': 'Note: runtimeRoot and DSH_HOME must be on the same disk (built-in plugins link via junctions). Current runtimeRoot =',
  'settings.sourceTitle': '⚠ Source mode: download / update Harness source (advanced — not recommended for beginners)',
  'settings.sourceDesc': 'Only click here if you need to debug or modify the Harness source. Regular users should use "Quick Offline Deployment" above — no source needed.',
  'settings.sourceDesc2.pre': 'Clones / updates',
  'settings.sourceDesc2.to': 'to',
  'settings.sourceDesc2.mid': 'and installs dependencies and auto-configures paths. Requires Node and pnpm on this machine; if the directory already exists it runs',
  'settings.sourceDesc2.tail': '.',
  'settings.downloadBtn': 'Download / Update Source',
  'settings.downloading': 'Downloading…',
  'settings.downloadDone': '✔ Done — paths have been auto-configured.',
  'settings.pathsTitle': 'Paths & Launch',
  'settings.runMode': 'Run mode',
  'settings.modeOptionBundled': 'Bundled runtime (no Node needed)',
  'settings.modeOptionSource': 'Source build (system Node + source repo)',
  'settings.runtimeRoot': 'Runtime directory (runtimeRoot)',
  'settings.runtimeRootHint': 'Where the portable Node + built-in dsh are installed',
  'settings.harnessRepo': 'Harness repo',
  'settings.harnessRepoHint': 'Directory of the dsh CLI source (source mode)',
  'settings.harnessRepoUrl': 'Harness repo URL',
  'settings.harnessRepoUrlHint': 'Clone URL used by one-click download / update',
  'settings.dshHome': 'DSH_HOME',
  'settings.dshHomeHint': 'Directory for profiles/sessions/storages',
  'settings.pluginDir': 'Local plugin directory',
  'settings.pluginDirHint': 'Directory scanned for available plugins (e.g. DSH-Plugin)',
  'settings.deepseekApiKey': 'DeepSeek API Key (optional)',
  'settings.deepseekApiKeyHint': 'For the balance widget only; leave empty to read ~/.dsh/.credentials.yaml',
  'settings.port': 'Port',
  'settings.profile': 'profile',
  'settings.profileHint': 'Profile name to launch (default web)',
  'settings.nodePath': 'Node executable',
  'settings.launchArgs': 'Launch command (launchArgs, space-separated)',
  'settings.launchArgsHint': 'Final:',
  'settings.buildCmd': 'Build command',
  'settings.pnpm': 'pnpm executable',
  'settings.stopOnQuit': 'Stop the Harness process when the app closes',
  'settings.startupTimeout': 'Startup timeout (ms)',
  'settings.saved': 'Saved ✓',
  'settings.save': 'Save Settings',
  'settings.autoSavedHint': 'System settings are saved automatically — no manual save needed.',
  'settings.apiTitle': 'API Switching',
  'settings.apiDesc': 'Switch between multiple AI provider presets with one click. A restart of dsh is required for the change to take effect — at launch, the provider’s URL and API key are injected automatically (also used for balance queries), so you never have to fill them in the DSH UI. If a preset has no key, the one in',
  'settings.apiDesc.tail': ' is used.',
  'settings.noPresets': 'No presets yet — click "Add preset" below to create one.',
  'settings.presetNamePlaceholder': 'Provider name',
  'settings.current': 'Active',
  'settings.setActive': 'Set as active',
  'settings.delete': 'Delete',
  'settings.baseUrl': 'Model API URL (baseUrl)',
  'settings.balanceUrl': 'Balance endpoint (balanceUrl, optional)',
  'settings.apiKey': 'API Key (injected into dsh for model calls + balance queries)',
  'settings.addPreset': 'Add preset',
  'settings.newPresetName': 'New provider',
  'settings.maintenanceTitle': 'Maintenance (source mode)',
  'settings.maintenanceDesc.pre': 'After missing dependencies (like the last',
  'settings.maintenanceDesc.tail': ' error) or source changes, reinstall / rebuild in the repo first, then start.',
  'settings.repair': 'Repair dependencies (pnpm install)',
  'settings.rebuild': 'Rebuild (pnpm run build)',
  // plugins page — local / market tabs
  'plugins.tabLocal': 'Local Plugins',
  'plugins.tabMarket': 'Plugin Market',
  // plugin market
  'market.searchPlaceholder': 'Search plugins (name / description)…',
  'market.refresh': 'Refresh',
  'market.loading': 'Loading the plugin market…',
  'market.empty': 'No matching plugins found.',
  'market.error': 'Failed to load:',
  'market.total': '{count} plugin(s)',
  'market.updated': 'Updated {date}',
  'market.install': 'Install',
  'market.installed': 'Installed',
  'market.multiPackage': 'This repo ships multiple plugin packages — pick one to install:',
  'market.installSub': 'Install subpackage',
  'market.details': 'View details',
  'market.readmeTitle': 'README',
  'market.readmeLoading': 'Loading README…',
  'market.noReadme': 'This repository has no README.',
  'market.close': 'Close',
  'market.pagePrev': 'Previous',
  'market.pageNext': 'Next',
  'market.pageOf': 'Page {page} of {pages}',
  'market.readmeFailed': 'Failed to load the README.'
}

const messages: Record<Lang, Record<string, string>> = { zh, en }

/** Look up a message for a language, substituting {params}. Falls back to zh, then the key itself. */
export function translate(lang: Lang, key: string, params?: Params): string {
  const table = messages[lang] ?? zh
  let s = table[key] ?? zh[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v))
    }
  }
  return s
}

/** Status code → localized label; unknown codes pass through as themselves. */
export function statusText(lang: Lang, status: string | undefined): string {
  if (!status) return translate(lang, 'status.unknown')
  const key = `status.${status}`
  const table = messages[lang] ?? zh
  return table[key] ?? zh[key] ?? status
}

/** Localized duration, e.g. "3 秒" / "3 sec". */
export function formatDuration(ms: number, lang: Lang): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return lang === 'en' ? `${s} sec` : `${s} 秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (r > 0) return lang === 'en' ? `${m} min ${r} sec` : `${m} 分 ${r} 秒`
  return lang === 'en' ? `${m} min` : `${m} 分`
}

// Module-level mirror of the current language so non-component code (e.g. the
// useHarness task handler) can read it without React context. Kept in sync by
// I18nProvider on every render.
let currentLang: Lang = 'zh'
export function getLang(): Lang {
  return currentLang
}

/** Guess the language before config loads, so a non-Chinese user isn't flashed Chinese. */
function guessLang(): Lang {
  try {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

interface I18nContextValue {
  lang: Lang
  /** Dictionary lookup for the active language (params optional). */
  t: (key: string, params?: Params) => string
  /** Localized status label for a harness status code. */
  statusLabel: (status: string | undefined) => string
  /** Persist a new language via config (main process follows on next read). */
  setLang: (lang: Lang) => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  const { config, saveConfig } = useHarness()
  // Before config loads, fall back to the system language to avoid flashing
  // Chinese at non-Chinese users; afterwards follow the persisted language.
  const lang: Lang = config ? (config.language === 'en' ? 'en' : 'zh') : guessLang()
  currentLang = lang

  const t = useCallback((key: string, params?: Params) => translate(lang, key, params), [lang])
  const statusLabel = useCallback((status: string | undefined) => statusText(lang, status), [lang])
  const setLang = useCallback(
    (next: Lang) => {
      if (next === lang) return
      void saveConfig({ language: next })
    },
    [lang, saveConfig]
  )

  return <I18nContext.Provider value={{ lang, t, statusLabel, setLang }}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>')
  return ctx
}
