// dshfind.com 插件源适配器。
// API(2026-08 实测):GET /api/plugins-data 单次返回全量 4.3MB JSON
// ({ plugins: 7392 条, i18nDescriptions }),无服务端搜索/分页 → 主进程缓存后过滤分页。
//
// 缓存策略:懒加载(切到该源才拉)+ TTL 30 分钟 + stale-while-revalidate(过期先返回
// 旧数据,后台刷新失败静默保留)+ force 强制重拉(工具栏「刷新」),不落盘。
import { net } from 'electron'
import { t } from './i18n'
import { perPage } from './market'
import { DSHFIND_CATEGORY_NAMES, hashString } from '../shared/plugin-sources'
import type { MarketPage, MarketRepo, SourceCategory } from '../shared/types'

const API_C = 'https://dshfind.com'
const TTL_MS = 30 * 60 * 1000

interface DshfindItem {
  fullName?: string
  name?: string
  owner?: string
  url?: string
  description?: string
  tags?: string[]
  language?: string
  stars?: number
  pushedAt?: string
  category?: string
  isRisky?: boolean
  riskNote?: string | null
  archived?: boolean
  score?: number
}

interface DshfindResponse {
  plugins?: DshfindItem[]
}

let cache: { items: DshfindItem[]; fetchedAt: number } | null = null
let inflight: Promise<DshfindItem[] | null> | null = null // 并发去重:任意时刻最多一次在途拉取

/** 拉取全量数据并写入缓存。所有路径(冷拉 / 过期后台刷新 / force)共用这一个去重入口。 */
async function download(): Promise<DshfindItem[] | null> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await net.fetch(`${API_C}/api/plugins-data`)
      if (!res.ok) return null
      const body = (await res.json().catch(() => null)) as DshfindResponse | null
      if (!body?.plugins) return null
      cache = { items: body.plugins, fetchedAt: Date.now() }
      return body.plugins
    } catch {
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}

async function fetchItems(force: boolean): Promise<DshfindItem[] | null> {
  // 强制重拉(工具栏「刷新」);失败保留旧缓存(成功与否调用方按结果处理)
  if (force) return (await download()) ?? cache?.items ?? null
  // 新鲜缓存
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.items
  // 过期:先回旧数据,后台刷新(失败静默保留旧数据;inflight 去重,不会并发多拉)
  if (cache) {
    void download()
    return cache.items
  }
  // 无缓存:拉取
  return download()
}

function normalizeDshfind(raw: DshfindItem): MarketRepo {
  const fullName = raw.fullName ?? ''
  const owner = raw.owner ?? fullName.split('/')[0] ?? ''
  const repo = fullName.split('/')[1] ?? raw.name ?? ''
  return {
    id: hashString(fullName),
    owner,
    repo,
    fullName,
    description: raw.description ?? null,
    htmlUrl: raw.url ?? `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    stars: raw.stars ?? 0,
    forks: 0, // 源C 无 forks 字段
    language: raw.language ?? null,
    updatedAt: raw.pushedAt ?? '',
    topics: raw.tags ?? [], // 已知 topic 词自动点亮卡片分类 chips
    avatarUrl: `https://avatars.githubusercontent.com/${owner}?s=64`,
    defaultBranch: 'main', // README 渲染基址必需
    source: 'dshfind',
    score: raw.score,
    isRisky: raw.isRisky,
    riskNote: raw.riskNote ?? undefined,
    archived: raw.archived
  }
}

function buildCategories(items: DshfindItem[]): SourceCategory[] {
  const counts = new Map<string, number>()
  for (const it of items) {
    if (!it.category) continue // 空 category 的 2809 条只出现在「全部」
    counts.set(it.category, (counts.get(it.category) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => {
      const names = DSHFIND_CATEGORY_NAMES[id]
      return {
        id,
        zhName: names?.zh ?? id,
        enName: names?.en ?? id,
        count
      }
    })
}

export async function searchDshfind(page: number, query?: string, categoryId?: string, force = false): Promise<MarketPage> {
  const p = Math.max(1, Math.floor(Number(page) || 1))
  const items = await fetchItems(force)
  if (!items) {
    return { ok: false, repos: [], totalCount: 0, page: p, error: t('从 dshfind.com 加载插件数据失败,请点击刷新重试。', 'Failed to load plugin data from dshfind.com; click Refresh to retry.') }
  }

  const kw = String(query ?? '').trim().toLowerCase()
  const hit = (it: DshfindItem): boolean => {
    if (!kw) return true
    return [it.fullName, it.name, it.description, ...(it.tags ?? [])].join(' ').toLowerCase().includes(kw)
  }
  const byCat = (it: DshfindItem): boolean => categoryId === 'all' || categoryId === undefined || it.category === categoryId
  const filtered = items
    .filter(hit)
    .filter(byCat)
    // fullName 声明为可选(源数据理论上可能缺失),比较时兜底空串,避免 TypeError
    .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || (a.fullName ?? '').localeCompare(b.fullName ?? ''))

  const per = perPage()
  const slice = filtered.slice((p - 1) * per, p * per)
  return {
    ok: true,
    repos: slice.map(normalizeDshfind),
    totalCount: filtered.length,
    page: p,
    categories: buildCategories(items)
  }
}
