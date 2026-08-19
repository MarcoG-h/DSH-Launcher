// Plugin market: GitHub search for repositories tagged `dsh-plugin`, plus
// README fetching for the detail modal. Uses Electron's `net.fetch` so requests
// route through the system proxy (important for users behind GFW).
import { net } from 'electron'
import { getConfig } from './config'
import { t } from './i18n'
import type { MarketPage, MarketReadme, MarketRepo, MarketSourceId } from '../shared/types'
import { categoryTopic } from '../shared/market-categories'
import { search1024 } from './market-1024'
import { searchDshfind } from './market-dshfind'

const API = 'https://api.github.com'

export function perPage(): number {
  const n = getConfig().marketPageSize
  return Math.min(50, Math.max(10, Number.isFinite(n) ? Math.floor(n) : 30))
}

function ua(): string {
  return 'dsh-launcher/1.0.0 (https://github.com/MarcoG-h/DSH-Launcher)'
}

async function gh(path: string, accept = 'application/vnd.github+json'): Promise<{ status: number; body: unknown }> {
  const res = await net.fetch(`${API}${path}`, {
    headers: {
      Accept: accept,
      'User-Agent': ua()
    }
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/**
 * 插件市场入口:按 sourceId 分派到对应源(GitHub topic 搜索 / DSH 1024Store /
 * dshfind.com)。统一归一化为 MarketRepo,下载与 README 走同一链路。
 */
export async function searchMarket(
  sourceId: MarketSourceId,
  page: number,
  query?: string,
  categoryId?: string,
  force?: boolean
): Promise<MarketPage> {
  if (sourceId === 'dsh1024') return search1024(page, query, categoryId)
  if (sourceId === 'dshfind') return searchDshfind(page, query, categoryId, force)
  return searchGithub(page, query, categoryId)
}

/**
 * GitHub 源:Page 1..N of the market, sorted by stars desc. A `query` adds a
 * keyword to the GitHub search so results span the whole topic, not just the
 * current page. An optional `categoryId` maps to a single `topic:<word>`
 * qualifier (GitHub's Search API only ANDs — OR/括号 on qualifiers实测无效, so a
 * category is always one topic word, see shared/market-categories.ts).
 * Unauthenticated GitHub API.
 */
async function searchGithub(page: number, query?: string, categoryId?: string): Promise<MarketPage> {
  const p = Math.max(1, Math.floor(Number(page) || 1))
  const kw = String(query ?? '').trim()
  const parts = ['topic:dsh-plugin']
  if (kw) parts.push(kw)
  const topic = categoryTopic(categoryId) // 未知 id → 空串 → 静默不过滤
  if (topic) parts.push(`topic:${topic}`)
  const q = parts.join(' ')
  const { status, body } = await gh(
    `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage()}&page=${p}`
  )

  if (status === 403) {
    return {
      ok: false,
      repos: [],
      totalCount: 0,
      page: p,
      error: t('GitHub API 请求受限(限流),请稍后再试。', 'GitHub API rate limit reached; please try again later.')
    }
  }
  if (status !== 200 || !body || typeof body !== 'object') {
    return {
      ok: false,
      repos: [],
      totalCount: 0,
      page: p,
      error: t('从 GitHub 获取插件列表失败。', 'Failed to fetch the plugin list from GitHub.')
    }
  }

  const data = body as { total_count?: number; items?: unknown[] }
  const repos: MarketRepo[] = (data.items ?? [])
    // The harness itself carries the `dsh-plugin` topic but is the host, not a plugin.
    .filter((it) => (it as { full_name?: string }).full_name !== 'deepseek-ai/deepseek-harness')
    .map((it) => {
    const r = it as {
      id: number
      name: string
      full_name: string
      owner?: { login: string; avatar_url: string }
      description: string | null
      html_url: string
      clone_url: string
      stargazers_count: number
      forks_count: number
      language: string | null
      updated_at: string
      topics?: string[]
      default_branch: string
    }
    return {
      id: r.id,
      owner: r.owner?.login ?? '',
      repo: r.name,
      fullName: r.full_name,
      description: r.description,
      htmlUrl: r.html_url,
      cloneUrl: r.clone_url,
      stars: r.stargazers_count,
      forks: r.forks_count,
      language: r.language,
      updatedAt: r.updated_at,
      topics: r.topics ?? [],
      avatarUrl: r.owner?.avatar_url ?? '',
      defaultBranch: r.default_branch
    }
  })
  return { ok: true, repos, totalCount: data.total_count ?? 0, page: p }
}

/** Raw markdown of a repository README (Accept: raw returns the file content directly). */
export async function fetchReadme(owner: string, repo: string): Promise<MarketReadme> {
  const o = String(owner)
  const r = String(repo)
  if (!o || !r) return { ok: false, error: t('缺少仓库信息。', 'Missing repository info.') }
  // net.fetch 会在断网 / DNS 失败 / 超时 / 证书错误时 reject —— 捕获后走错误页,
  // 不能让 rejection 穿透 IPC 到渲染层。
  let res: Response
  try {
    res = await net.fetch(`${API}/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/readme`, {
      headers: {
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': ua()
      }
    })
  } catch {
    return { ok: false, error: t('加载 README 失败。', 'Failed to load the README.') }
  }
  if (res.status === 404) {
    return { ok: false, error: t('该仓库没有 README。', 'This repository has no README.') }
  }
  if (res.status === 403) {
    return { ok: false, error: t('GitHub API 请求受限(限流),无法加载 README。', 'GitHub API rate limit reached; cannot load the README.') }
  }
  if (!res.ok) {
    return { ok: false, error: t('加载 README 失败。', 'Failed to load the README.') }
  }
  const text = await res.text()
  return { ok: true, text }
}
