import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api, type InstalledPlugin, type LocalPlugin, type MarketPage, type MarketRepo } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { RefreshIcon } from '../lib/icons'
import { MarketModal } from './MarketModal'
import { CopyButton } from './CopyButton'
import { MARKET_CATEGORIES, categoryById, matchCategories } from '../../../shared/market-categories'
import { ALL_CATEGORY, MARKET_SOURCES } from '../../../shared/plugin-sources'
import type { MarketSourceId } from '../../../shared/types'

// GitHub search caps results at 1000 repos; both constants derive from the
// per-page setting in 系统管理 (Settings → System).
function clampPageSize(n: number): number {
  return Math.min(50, Math.max(10, Number.isFinite(n) ? Math.floor(n) : 30))
}

function fmtDate(iso: string, lang: 'zh' | 'en'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

interface Props {
  installed: InstalledPlugin[]
  local: LocalPlugin[]
  /** 矩阵里任意实例已启用的插件名(含 dsh plugin add 直装进非活动实例的),也标为已下载。 */
  extraInstalledNames?: string[]
  /** Re-query the local plugin list so the "installed" state refreshes after an install. */
  onRefresh: () => void
}

/** Plugin market tab: GitHub repos tagged `dsh-plugin`, sorted by stars, paged. */
export function MarketTab({ installed, local, extraInstalledNames, onRefresh }: Props): JSX.Element {
  const { t, lang } = useI18n()
  const { config } = useHarness()
  const perPage = clampPageSize(config?.marketPageSize ?? 30)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<MarketPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [category, setCategory] = useState<string>('all')
  const [source, setSource] = useState<MarketSourceId>(config?.marketSource ?? 'github')
  const [selected, setSelected] = useState<MarketRepo | null>(null)
  // 请求序号:快速切换源/翻页时,只接受最后一次发出的响应(旧响应晚到则丢弃)。
  const seqRef = useRef(0)
  // GitHub 搜索结果上限 1000 条;新源(dsh1024/dshfind)没有该限制。
  const maxPage = source === 'github' ? Math.max(1, Math.floor(1000 / perPage)) : 10000

  // Persist the chosen source; also adopt a saved source once config arrives.
  useEffect(() => {
    if (config?.marketSource && config.marketSource !== source) setSource(config.marketSource)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.marketSource])

  useEffect(() => {
    void api.setConfig({ marketSource: source })
  }, [source])

  const load = useCallback(
    async (p: number, q: string, c: string, force?: boolean): Promise<void> => {
      const seq = ++seqRef.current
      setLoading(true)
      setError(null)
      try {
        const r = await api.searchMarket(source, p, q, c, force)
        if (seq !== seqRef.current) return // 已有更新的请求发出,丢弃这条过期响应
        if (r.ok) {
          setData(r)
        } else {
          setError(r.error ?? t('market.error'))
        }
      } catch (e) {
        if (seq !== seqRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    },
    [t, source]
  )

  // Search runs server-side (GitHub search API) so a keyword spans the whole
  // topic — debounce keystrokes, then reload from page 1.
  useEffect(() => {
    const h = setTimeout(() => {
      setDebouncedQuery(query)
      setPage(1)
    }, 300)
    return () => clearTimeout(h)
  }, [query])

  useEffect(() => {
    // Category switch (or a debounced keyword) always reloads from page 1 —
    // reset the pager state too, or it would point past the new page count.
    setPage(1)
    void load(1, debouncedQuery, category)
  }, [load, debouncedQuery, category])

  // Local install detection: GitHub clones land in pluginDir under the repo name,
  // npm-installed plugins are keyed by package name — match either. Also covers
  // plugins installed into any instance (matrix-enabled), not just the active profile.
  const installedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const p of installed) keys.add(p.name)
    for (const p of local) {
      keys.add(p.name)
      const base = p.path.split(/[\\/]/).pop()
      if (base) keys.add(base)
    }
    for (const n of extraInstalledNames ?? []) keys.add(n)
    return keys
  }, [installed, local, extraInstalledNames])

  const isInstalled = (repo: MarketRepo): boolean => installedKeys.has(repo.repo) || installedKeys.has(repo.fullName)

  const repos = data?.repos ?? []
  // 总页数按该源的实际每页条数算(源B 服务端固定 100/页);GitHub / 源C 缺省用配置值。
  const totalPages = Math.min(maxPage, Math.max(1, Math.ceil((data?.totalCount ?? 0) / (data?.pageSize ?? perPage))))
  const goto = (p: number): void => {
    setPage(p)
    void load(p, debouncedQuery, category)
  }

  // 分类 chips:GitHub 源用内置 topic 分类;新源用服务端/适配器返回的分类(数据到达后出现)。
  const categories = source === 'github' ? MARKET_CATEGORIES : [ALL_CATEGORY, ...(data?.categories ?? [])]

  return (
    <div className="space-y-4">
      {/* toolbar: search + count + refresh on the left, source switch pinned right */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-[160px] max-w-[400px] flex-1"
          placeholder={t('market.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--muted)' }}>
          {t('market.total', { count: data?.totalCount ?? 0 })}
        </span>
        <button className="btn btn-ghost btn-sm shrink-0" disabled={loading} onClick={() => void load(page, debouncedQuery, category, true)}>
          <RefreshIcon /> {t('market.refresh')}
        </button>
        <span className="ml-auto shrink-0 text-[11.5px]" style={{ color: 'var(--muted)' }}>
          {t('market.sourceLabel')}
        </span>
        <select
          className="input h-auto w-auto min-w-[100px] max-w-[130px] shrink-0"
          value={source}
          title={lang === 'zh' ? MARKET_SOURCES.find((s) => s.id === source)?.zhDesc : MARKET_SOURCES.find((s) => s.id === source)?.enDesc}
          onChange={(e) => {
            const s = e.target.value as MarketSourceId
            setSource(s)
            setCategory('all') // 切换源:分类重置为「全部」
          }}
        >
          {MARKET_SOURCES.map((src) => (
            <option key={src.id} value={src.id}>
              {lang === 'zh' ? src.zhName : src.enName}
            </option>
          ))}
        </select>
      </div>

      {/* category chips: each maps to one GitHub topic qualifier (server-side AND with the keyword) */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--muted)' }}>
          {t('market.categoryLabel')}
        </span>
        <div className="flex gap-1.5 overflow-x-auto py-0.5">
          {categories.map((c) => {
            const active = c.id === category
            return (
              <button
                key={c.id}
                className="badge shrink-0 cursor-pointer whitespace-nowrap transition-colors"
                style={
                  active
                    ? { color: 'var(--accent)', background: 'var(--accent-soft)', border: '1px solid var(--accent)' }
                    : { color: 'var(--muted)', background: 'var(--bg-soft)', border: '1px solid transparent' }
                }
                onClick={() => setCategory(c.id)}
              >
                {lang === 'zh' ? c.zhName : c.enName}
              </button>
            )
          })}
        </div>
      </div>

      {error && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[12.5px]"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}
        >
          <span className="select-text break-all">
            {t('market.error')} {error}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <CopyButton text={`${t('market.error')} ${error}`} />
            <button className="btn btn-ghost btn-sm" onClick={() => void load(page, debouncedQuery, category, true)}>
              {t('market.refresh')}
            </button>
          </span>
        </div>
      )}

      {loading && !data ? (
        <div className="py-12 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
          {t('market.loading')}
        </div>
      ) : repos.length === 0 ? (
        <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
          {t('market.empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map((r) => {
            const installedFlag = isInstalled(r)
            return (
              <div
                key={r.id}
                className="card flex cursor-pointer flex-col gap-2.5 p-4 transition-colors"
                style={{ borderColor: 'var(--border)' }}
                onClick={() => setSelected(r)}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
              >
                <div className="flex items-center gap-2.5">
                  <img
                    src={r.avatarUrl}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded-full"
                    style={{ background: 'var(--bg-soft)' }}
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mono truncate text-[13.5px] font-semibold">{r.fullName}</div>
                    <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      ⭐ {r.stars}
                      {r.language ? ` · ${r.language}` : ''}
                    </div>
                  </div>
                  {installedFlag && (
                    <span className="badge shrink-0" style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }}>
                      {t('market.installed')}
                    </span>
                  )}
                </div>
                <p className="line-clamp-2 flex-1 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                  {r.description ?? '—'}
                </p>
                {(() => {
                  const cats = matchCategories(r.topics)
                  return cats.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {cats.slice(0, 3).map((id) => {
                        const c = categoryById(id)
                        return c ? (
                          <button
                            key={id}
                            className="badge shrink-0 cursor-pointer whitespace-nowrap"
                            style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}
                            title={t('market.filterByCategory')}
                            onClick={(e) => {
                              e.stopPropagation()
                              setCategory(id)
                            }}
                          >
                            {lang === 'zh' ? c.zhName : c.enName}
                          </button>
                        ) : null
                      })}
                    </div>
                  ) : null
                })()}
                <div className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                    {t('market.updated', { date: fmtDate(r.updatedAt, lang) })}
                  </span>
                  <span className="text-[12px] font-medium" style={{ color: 'var(--accent)' }}>
                    {t('market.details')} →
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {data && (
        <div className="flex items-center justify-center gap-3 text-[12.5px]">
          <button className="btn btn-ghost btn-sm" disabled={page <= 1 || loading} onClick={() => goto(page - 1)}>
            {t('market.pagePrev')}
          </button>
          <span style={{ color: 'var(--muted)' }}>{t('market.pageOf', { page: String(page), pages: String(totalPages) })}</span>
          <button className="btn btn-ghost btn-sm" disabled={page >= totalPages || loading} onClick={() => goto(page + 1)}>
            {t('market.pageNext')}
          </button>
        </div>
      )}

      {/* 当前来源介绍:始终显示在页面最底部,跟随工具栏选的来源 */}
      {(() => {
        const meta = MARKET_SOURCES.find((s) => s.id === source)
        if (!meta) return null
        return (
          <div className="px-4 pb-2 text-center text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            <span className="mr-1.5 font-semibold" style={{ color: 'var(--fg)' }}>
              {lang === 'zh' ? meta.zhName : meta.enName}
            </span>
            {lang === 'zh' ? meta.zhDesc : meta.enDesc}
          </div>
        )
      })()}

      {selected && (
        <MarketModal
          repo={selected}
          isInstalled={isInstalled(selected)}
          onClose={() => setSelected(null)}
          onInstalled={() => {
            onRefresh()
            setSelected(null)
          }}
        />
      )}
    </div>
  )
}
