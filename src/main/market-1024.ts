// deepseek1024.com(DSH 1024Store)插件源适配器。
// API(2026-08 实测):GET /api/v2/plugins?per_page=&page=&q=&category=
// → { plugins, total, totalPages, categories:[{id,en,zh,count}], ... },服务端分页/搜索/分类。
// 走 Electron net.fetch(与 GitHub 源一致,路由系统代理)。
import { net } from 'electron'
import { getConfig } from './config'
import { t } from './i18n'
import { hashString } from '../shared/plugin-sources'
import type { MarketPage, MarketRepo, SourceCategory } from '../shared/types'

const API_B = 'https://deepseek1024.com'

interface ApiPlugin {
  id?: string // "owner/repo/subdir" 格式
  name?: string
  owner?: string
  repository?: string
  url?: string
  category?: string
  description?: { en?: string; zh?: string }
  install?: string
  stars?: number
  forks?: number
  pushedAt?: string
  updatedAt?: string
  latestReleaseAt?: string
  installs30d?: number
}

interface ApiV2Response {
  plugins?: ApiPlugin[]
  total?: number
  categories?: { id: string; en: string; zh: string; count?: number }[]
}

/** 从 install 命令解析 #path:subdir(定位多子包仓库里的插件子包)。 */
function subdirFromInstall(install: string | undefined): string | undefined {
  if (!install) return undefined
  const m = install.match(/#path:([^\s]+)/)
  const s = m?.[1]?.replace(/\/+$/, '')
  return s || undefined
}

function normalize1024(raw: ApiPlugin): MarketRepo {
  const parts = String(raw.id ?? '').split('/') // id 格式 "owner/repo/subdir"
  const owner = parts[0] ?? raw.owner ?? ''
  const repo = parts[1] ?? (raw.repository ?? '').split('/')[1] ?? owner
  const fullName = `${owner}/${repo}`
  // 双语描述按 UI 语言取
  const zh = getConfig().language === 'zh'
  const desc = (zh ? raw.description?.zh : raw.description?.en) || raw.description?.en || raw.description?.zh || null
  return {
    // 同一仓库的 base 条目与各 subdir 子包条目 fullName 相同 —— 必须用完整原始 id
    // ("owner/repo" 或 "owner/repo/subdir")做 key,否则列表里出现重复 React key。
    id: hashString(raw.id ?? fullName),
    owner,
    repo,
    fullName,
    description: desc,
    htmlUrl: raw.url ?? `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    stars: raw.stars ?? 0,
    forks: raw.forks ?? 0,
    language: null,
    updatedAt: raw.latestReleaseAt ?? raw.pushedAt ?? raw.updatedAt ?? '',
    topics: [], // 无 tags
    avatarUrl: `https://avatars.githubusercontent.com/${owner}?s=64`,
    defaultBranch: 'main', // README 渲染基址必需
    source: 'dsh1024',
    installs30d: raw.installs30d,
    subdirHint: subdirFromInstall(raw.install)
  }
}

// 服务端实测忽略 per_page 参数,固定每页 100 条(返回 totalPages 字段)。
const SERVER_PAGE_SIZE = 100

export async function search1024(page: number, query?: string, categoryId?: string): Promise<MarketPage> {
  const p = Math.max(1, Math.floor(Number(page) || 1))
  const params = new URLSearchParams({ page: String(p) })
  const kw = String(query ?? '').trim()
  if (kw) params.set('q', kw)
  if (categoryId && categoryId !== 'all') params.set('category', categoryId)

  let res: Response
  try {
    res = await net.fetch(`${API_B}/api/v2/plugins?${params}`)
  } catch {
    return { ok: false, repos: [], totalCount: 0, page: p, error: t('从 DSH 1024Store 获取插件列表失败。', 'Failed to fetch plugins from DSH 1024Store.') }
  }
  if (!res.ok) {
    return { ok: false, repos: [], totalCount: 0, page: p, error: t('从 DSH 1024Store 获取插件列表失败。', 'Failed to fetch plugins from DSH 1024Store.') }
  }
  const body = (await res.json().catch(() => null)) as ApiV2Response | null
  if (!body?.plugins) {
    return { ok: false, repos: [], totalCount: 0, page: p, error: t('从 DSH 1024Store 获取插件列表失败。', 'Failed to fetch plugins from DSH 1024Store.') }
  }
  return {
    ok: true,
    repos: body.plugins.map(normalize1024),
    totalCount: body.total ?? 0,
    page: p,
    // 真实每页条数与配置无关 —— 渲染层用它算总页数,避免页码虚高。
    pageSize: SERVER_PAGE_SIZE,
    categories: (body.categories ?? []).map((c): SourceCategory => ({ id: c.id, zhName: c.zh, enName: c.en, count: c.count }))
  }
}
