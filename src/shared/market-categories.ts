// 插件市场分类:每分类**固定映射 1 个 GitHub topic 词**。
//
// GitHub Search API 的 qualifier 上 OR/括号实测无效(2026-08 curl 验证,
// `(topic:a OR topic:b)` 返回 total 0),只有空格 = AND 可靠——因此不配置
// 同义词 OR 组,筛选时在 q 中追加单个 `topic:<word>` 与关键词天然 AND。
//
// 词表来自对 `topic:dsh-plugin` 仓库的 topics 频次扫描 + 逐词存量实测
// (mcp=257, vision=145, memory=117, security=72, balance=45, ui=43,
// automation=37, notification=34, session=24;tools=4 因低于阈值且语义过宽
// 已剔除)。换词/加词只改本文件即可。
//
// 注意 `balance` 语义是「余额/成本管控」(dsh 生态的计费监控类插件),
// 不是「均衡/权衡」,勿据此改词。

export interface MarketCategory {
  id: string // 稳定 id,用于 IPC / 组件状态;'all' 为默认分类
  zhName: string // 中文显示名(中文优先界面)
  enName: string // 英文显示名
  topic: string // GitHub topic 词(小写精确匹配);'all' 为空串
}

export const MARKET_CATEGORIES: MarketCategory[] = [
  { id: 'all', zhName: '全部', enName: 'All', topic: '' },
  { id: 'mcp', zhName: '工具与集成', enName: 'Tools & Integrations', topic: 'mcp' },
  { id: 'vision', zhName: '视觉', enName: 'Vision', topic: 'vision' },
  { id: 'memory', zhName: '记忆', enName: 'Memory', topic: 'memory' },
  { id: 'security', zhName: '安全', enName: 'Security', topic: 'security' },
  { id: 'balance', zhName: '成本', enName: 'Cost', topic: 'balance' },
  { id: 'ui', zhName: '界面增强', enName: 'UI', topic: 'ui' },
  { id: 'automation', zhName: '自动化', enName: 'Automation', topic: 'automation' },
  { id: 'notification', zhName: '通知', enName: 'Notification', topic: 'notification' },
  { id: 'session', zhName: '会话', enName: 'Session', topic: 'session' }
]

const BY_ID: Record<string, MarketCategory> = Object.fromEntries(
  MARKET_CATEGORIES.map((c) => [c.id, c])
)

/** 仓库 topics → 命中的分类 id 列表(精确小写匹配;可多命中,可为空)。 */
export function matchCategories(topics: string[]): string[] {
  const set = new Set(topics.map((s) => s.toLowerCase()))
  return MARKET_CATEGORIES.filter((c) => c.topic && set.has(c.topic)).map((c) => c.id)
}

/** 分类 id → topic 词;未知 id 或「全部」返回空串(调用方视为不过滤)。 */
export function categoryTopic(id: string | undefined | null): string {
  return (id && BY_ID[id]?.topic) || ''
}

export function categoryById(id: string): MarketCategory | undefined {
  return BY_ID[id]
}
