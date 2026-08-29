import type { SecurityAuditEvent } from './api'

/** dsh 官方内置工具排除表:这些工具即使携带密钥也不告警。 */
export const OFFICIAL_TOOLS = new Set([
  'bash', 'shell', 'exec', 'execute', 'sh', 'cmd', 'powershell',
  'read', 'read_file', 'read_image', 'reader', 'cat', 'tail', 'head', 'ls', 'find', 'less',
  'write', 'write_file', 'writer', 'edit', 'str_replace_editor', 'sed', 'awk',
  'glob', 'grep', 'rg',
  'fetch', 'webfetch', 'web_fetch', 'web', 'web_search', 'websearch', 'web_fetch',
  'http-client', 'http_client', 'http', 'request', 'curl',
  'ask', 'ask_user_question', 'ready', 'complete', 'completed', 'task', 'todo', 'plan', 'agent',
  'global', 'global_tool', 'permission', 'browser', 'screenshot', 'navigate',
  'filesystem', 'list_dir', 'mkdir', 'rm', 'mv', 'cp', 'touch'
])

/** 事件类别(启动器端分类):消息改写 / 工具调用拦截 / 恶意风险。 */
export type EventCat = 'message' | 'tool' | 'malicious'
export const CAT_COLOR: Record<EventCat, string> = { message: '#3b82f6', tool: '#8b5cf6', malicious: '#ef4444' }
export const CAT_LABEL_KEY: Record<EventCat, string> = {
  message: 'security.catMessage',
  tool: 'security.catTool',
  malicious: 'security.catRisk'
}

/**
 * 有效风险判定:只有「工具事件 + 命中密钥标记 + 第三方工具(非官方 且 不在白名单)」
 * 才算风险。用户/助手消息只是对话内容,不告警。
 */
export function isRisk(e: SecurityAuditEvent, whitelist: string[]): boolean {
  if (!e.flags?.includes('credential')) return false
  if (e.type !== 'tool/call' && e.type !== 'tool/result') return false
  const actor = e.actor ?? ''
  if (OFFICIAL_TOOLS.has(actor)) return false
  if (whitelist.includes(actor)) return false
  return true
}

/** 事件 → 类别:风险 > 工具 > 消息。 */
export function categoryOf(e: SecurityAuditEvent, isRiskFn: (x: SecurityAuditEvent) => boolean): EventCat {
  if (isRiskFn(e)) return 'malicious'
  if (e.type === 'tool/call' || e.type === 'tool/result') return 'tool'
  return 'message'
}

/** 单条事件的风险颜色:红=工具调用带完整密钥(已泄露),橙=工具结果带完整密钥(高度疑似),黄=键名/部分(轻微疑似)。 */
export function riskColor(e: SecurityAuditEvent): string {
  if (e.sev === 2) return e.type === 'tool/call' ? '#ef4444' : '#f97316'
  return '#eab308'
}

/** 风险分级配色与文案:0绿 1黄 2橙 3红。 */
export const RISK_LEVELS = [
  { level: 0, color: '#22c55e', label: 'security.statusSafe' },
  { level: 1, color: '#eab308', label: 'security.statusMild' },
  { level: 2, color: '#f97316', label: 'security.statusHigh' },
  { level: 3, color: '#ef4444', label: 'security.statusLeaked' }
]

/** 计算整体安全状态:0绿 1黄 2橙 3红 + 风险事件数。 */
export function computeStatus(events: SecurityAuditEvent[], whitelist: string[]): { level: number; count: number } {
  let level = 0
  let count = 0
  for (const e of events) {
    if (!isRisk(e, whitelist)) continue
    count++
    if (e.sev === 2) {
      // 完整密钥在工具调用里(被发出去)= 已泄露(红);在工具结果里 = 高度疑似(橙)。
      level = Math.max(level, e.type === 'tool/call' ? 3 : 2)
    } else {
      level = Math.max(level, 1) // 仅键名/部分模式 = 轻微疑似(黄)
    }
  }
  return { level, count }
}
