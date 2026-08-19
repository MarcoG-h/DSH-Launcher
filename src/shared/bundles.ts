// Recommended bundle (整合包):「新手起步套装」+「社区精选增强包」两个纯社区整合包。
// 数据已**固化**在本文件(直接来自各社区插件仓库的清单,不依赖运行时同步)。
//
// 下载时机:点「下载」时由 installBundle 新建实例,并逐个 `dsh plugin add <spec>`
// 直装最新版。EAC 整合包(随包自研 + Agent 预设)已下架,相关数据与代码已移除。
//
// spec 约定:
// - 裸 npm 包名:已发布到 registry,直接 `dsh plugin add <name>`。
// - `github:owner/repo`:仓库根必须是含 dsh 字段的插件包;`#branch` 固定分支。
// - 完整 URL(tar.gz / codeload):锁定具体 tag 版本。
// - `flags`:个别插件的 peer 依赖不可满足(如 dsh-settings-organizer 的
//   schemastery ^3.18.1 在 registry 只有 3.18.0),需追加 pnpm 绕过参数才装得上。
//
// 已核实不可用、故未收录:dsh-skin(github:wei-806206088/dsh-skin)插件本体在
// packages/dsh-skin 子目录且无 dsh.bundle 字段,`dsh plugin add` 只能装出占位空包,
// 官方安装路径是 clone 仓库后跑 install.sh/install.ps1,与整合包机制不兼容。

import type { BundlePlugin, RecommendedBundle } from './types'

export type { BundlePlugin, RecommendedBundle } from './types'

/**
 * 整合包整体下载进度的任务标签(installBundle 用它广播 0..1 总进度)。
 * 按包 id 派生,主进程与渲染层都用同一函数取标签,不随语言变化。
 */
export function bundleTaskLabel(bundle: RecommendedBundle): string {
  return `整合包: ${bundle.id.toUpperCase()}`
}

/**
 * 11 个第三方社区插件(全部 `github:` 仓库直装)——「新手起步套装」的全部内容。
 * 每个都对应一个真实 GitHub 仓库;原清单里 4 个仓库不存在的(@dsh-external/dsh-automation、
 * @dsh-external/workflow、@openviking/dsh-memory-plugin、dsh-opencode-go-quota)、3 个虽有
 * 仓库但不可直装的(aegis 非 dsh 插件、dsh-tui workspace:* 依赖、dsh-find-plugin peer 冲突)
 * 均已移除。
 */
const STARTER_COMMUNITY: BundlePlugin[] = [
  { name: '@liustack/modlens', spec: 'github:liustack/modlens', description: '给纯文本模型添加视觉能力,粘贴图片即可进行问答' },
  { name: '@omdsh-dev/dsh-genui', spec: 'github:omdsh-dev/dsh-genui', description: '在 AI 回复中内联渲染图表、表单、Mermaid、3D 等交互 UI 组件' },
  { name: 'dsh-at-file', spec: 'github:omdsh-dev/dsh-at-file', description: '输入 @ 搜索并引用工作区文件路径,不注入文件内容' },
  { name: '@omdsh-dev/dsh-annotation', spec: 'github:omdsh-dev/dsh-annotation', description: '选中回复文本加批注随消息发送,模型按编号逐条回复批注' },
  { name: 'dsh-status-rotator', spec: 'github:01Virex/dsh-status-rotator', description: '定时轮播聊天状态提示语,短语可在设置面板自定义' },
  // vectorize-io/hindsight 是 monorepo,github: 直装只会取到无 dsh 字段的根包 → 走 npm。
  { name: '@vectorize-io/hindsight-coding-agents', spec: '@vectorize-io/hindsight-coding-agents', description: '为编码 Agent 提供长期项目记忆,自动后台沉淀 git 历史与对话知识' },
  { name: 'dsh-notification', spec: 'github:omdsh-dev/dsh-notification', description: '回复完成时发送浏览器桌面通知,支持按结果与关键词配置' },
  { name: 'dsh-chat-import', spec: 'github:Nwflower/dsh-chat-import', description: '导入 Claude/Codex/ChatGPT 等对话历史,转为可续聊的会话' },
  { name: '@anionex/dsh-vision-toolkit', spec: 'github:Anionex/dsh-vision-toolkit', description: '原生集成图片问答、OCR、截图比对等视觉能力' },
  { name: 'dsh-better-sidebar', spec: 'github:omdsh-dev/DSH-better-sidebar', description: '侧边栏工作台:文件管理、编辑预览、内嵌浏览器、真实终端、Git 面板' },
  { name: 'dsh-balance-tide', spec: 'github:huanyuLv/dsh-balance-tide', description: '输入框下显示 DeepSeek 余额、估算消耗与峰谷计价切换倒计时' }
]

/**
 * 27 个社区插件——「社区精选增强包」的全部内容。覆盖会话管理、记忆/上下文、
 * 插件治理、UI 增强与成本控制等方向。全部源经逐仓库/npm/URL 实测验证;唯一
 * 不可装的 dsh-skin 已排除(见文件头说明)。
 */
const COMMUNITY_BOOST: BundlePlugin[] = [
  { name: '@baihejiangnan/dsh-session-context-menu', spec: 'github:baihejiangnan/dsh-session-context-menu', description: '更好的右键:DSH 应用封装端的完整原生风格上下文菜单' },
  { name: 'zat-dsh-engine', spec: 'github:mishibeikejie/zat-dsh-engine', description: '可视化插件市场:浏览、搜索并一键安装社区插件' },
  { name: '@liustack/modlens', spec: '@liustack/modlens', description: '给纯文本模型添加视觉能力,粘贴图片即可进行问答' },
  { name: 'billion-context-dsh', spec: 'billion-context-dsh', description: '超长上下文:模型驱动的主动上下文压缩(ACP),长会话不爆窗' },
  { name: 'dsh-better-sidebar', spec: 'github:omdsh-dev/DSH-better-sidebar', description: '侧边栏工作台:文件管理、编辑预览、内嵌浏览器、真实终端、Git 面板' },
  { name: 'dsh-checkpoint-diff', spec: 'dsh-checkpoint-diff', description: '检查点差异可视化:只读时间轴 + 逐文件行级 diff,预览后回滚工作区' },
  { name: 'dsh-extension-hub', spec: 'dsh-extension-hub', description: '扩展中心:在设置页管理 skills、MCP 与插件,支持从 Claude/Codex 导入' },
  { name: 'dsh-tdai-memory', spec: 'dsh-tdai-memory', description: '腾讯云 Agent Memory 移植:对话捕获 → 结构化记忆提取 → 自动召回注入' },
  { name: 'dsh-web-mobile-fix', spec: 'dsh-web-mobile-fix', description: '移动端布局修复:窄屏下设置面板、弹窗、侧边栏与会话头自适应' },
  { name: 'dsh-what-changed', spec: 'dsh-what-changed', description: '看得见 Agent 改了什么:按会话汇总所有文件改动,一屏审阅后再提交' },
  { name: '@vlln/dsh-navbar', spec: 'github:vlln/dsh-navbar', description: '对话节点导航条:右缘节点串快速跳转 user 消息' },
  { name: 'dsh-balance-tide', spec: 'github:huanyuLv/dsh-balance-tide', description: '输入框下显示 DeepSeek 余额、估算消耗与峰谷计价切换倒计时' },
  { name: 'dsh-offpeak', spec: 'github:christophersmith2737-commits/OffPeak', description: '高峰涨价时段成本管控:自动弹窗提醒计费上涨,支持定时调度与指令重放' },
  { name: 'dsh-session-manager', spec: 'github:dream12347/dsh-session-manager', description: '会话管理器:删除对话(二次确认)并管理归档' },
  { name: 'dsh-undo-savepoint', spec: 'github:lire1131/dsh-undo-plugin', description: '崩溃救援:撤销配置与插件代码改动、密钥安全快照、一键安全模式' },
  { name: 'dsh-topbar-manager', spec: 'github:baihejiangnan/dsh-topbar-manager', description: '顶部工具栏管理:检查并控制其他插件添加的按钮显示/隐藏' },
  { name: '@dsh-external/dsh-side-session', spec: 'github:hzhz314159/dsh-side-session', description: '临时会话:独立悬浮窗,自动导入主对话上下文追问,不污染主会话' },
  // dsh-at-file 走 GitHub tag 固定版本(与 repo 直装等效),避免 spec 歧义。
  { name: 'dsh-at-file', spec: 'https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.3.tar.gz', description: '输入 @ 搜索并引用工作区文件路径,不注入文件内容' },
  { name: '@omdsh-dev/dsh-genui', spec: 'github:omdsh-dev/dsh-genui', description: '在 AI 回复中内联渲染图表、表单、Mermaid、3D 等交互 UI 组件' },
  // 经实测存在(dsh 字段为对象);npm 上无此包名,勿按 @dsh-external/dsh-automation 裸装。
  { name: '@dsh-external/dsh-automation', spec: 'github:titanwings/dsh-automation', description: '自动化:让 Coding 任务按计划在全新 Agent Session 中运行' },
  { name: 'dsh-notification', spec: 'github:omdsh-dev/dsh-notification', description: '回复完成时发送浏览器桌面通知,支持按结果与关键词配置' },
  { name: 'dsh-status-rotator', spec: 'github:01Virex/dsh-status-rotator', description: '定时轮播聊天状态提示语,短语可在设置面板自定义' },
  { name: 'dsh-auto-collapse', spec: 'github:a179-sanae/dsh-auto-collapse#main', description: '把工具卡片与 Think 推理块自动折叠成一行摘要,界面只留模型的话' },
  { name: 'dsh-plugin-guard', spec: 'github:lxzy-7/dsh-plugin-guard', description: '插件安装安全网:安装前快照、一键/自动回退、守护启动、事故报告' },
  { name: 'dsh-web-plugin-manager', spec: 'github:LX2000WASD/dsh-web-plugin-manager', description: 'Web UI 插件管理:列出、启停、安装/移除,含插件市场' },
  { name: 'dsh-plugin-healthcheck', spec: 'github:chenw2759-wq/dsh-plugin-healthcheck', description: '检测插件是否正常/是否含木马,防止装了就崩' },
  // peer 依赖 schemastery ^3.18.1 在 registry 只有 3.18.0 → 需绕过 peer 才装得上。
  { name: 'dsh-settings-organizer', spec: 'https://codeload.github.com/baihejiangnan/dsh-settings-organizer/tar.gz/refs/tags/v1.1.0', description: '设置页整理:可自定义的分层设置导航,只整理侧栏结构、不装改插件', flags: ['--strict-peer-dependencies=false', '--config.auto-install-peers=false'] }
]

/** 推荐整合包清单:EAC 已下架。 */
export const RECOMMENDED_BUNDLES: RecommendedBundle[] = [
  {
    id: 'tp',
    name: '新手起步套装',
    description: `社区精选入门包(${STARTER_COMMUNITY.length} 插件):图片问答与 OCR 视觉、内联图表/表单 UI、@文件引用、消息批注、多工具对话导入、桌面通知、长期编码记忆、余额与峰谷监控、状态轮播、侧边栏工作台,一键直装快速起步。`,
    community: [...STARTER_COMMUNITY]
  },
  {
    id: 'boost',
    name: '社区精选增强包',
    description: `增强进阶包(${COMMUNITY_BOOST.length} 插件):会话右键菜单与临时追问、插件市场/管理/守护/健康检查、超长上下文与腾讯云记忆、文件改动审阅与检查点回滚、余额与高峰成本管控、自动折叠工具卡片、顶栏/导航/移动端界面增强,深度定制你的 DSH。`,
    community: [...COMMUNITY_BOOST]
  }
]

/** 整合包插件总数。 */
export function bundleCount(bundle: RecommendedBundle): number {
  return bundle.community.length
}
