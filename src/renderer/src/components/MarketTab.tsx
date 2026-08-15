import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { api, type InstalledPlugin, type LocalPlugin, type MarketPage, type MarketRepo } from '../lib/api'
import { useI18n } from '../i18n'
import { RefreshIcon } from '../lib/icons'
import { MarketModal } from './MarketModal'

const PER_PAGE = 30
// GitHub search caps results at 1000 repos (page 34 at per_page=30).
const MAX_PAGE = 34

function fmtDate(iso: string, lang: 'zh' | 'en'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

interface Props {
  installed: InstalledPlugin[]
  local: LocalPlugin[]
  /** Re-query the local plugin list so the "installed" state refreshes after an install. */
  onRefresh: () => void
}

/** Plugin market tab: GitHub repos tagged `dsh-plugin`, sorted by stars, paged. */
export function MarketTab({ installed, local, onRefresh }: Props): JSX.Element {
  const { t, lang } = useI18n()
  const [page, setPage] = useState(1)
  const [data, setData] = useState<MarketPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MarketRepo | null>(null)

  const load = useCallback(
    async (p: number): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const r = await api.searchMarket(p)
        if (r.ok) {
          setData(r)
        } else {
          setError(r.error ?? t('market.error'))
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [t]
  )

  useEffect(() => {
    void load(1)
  }, [load])

  // Local install detection: GitHub clones land in pluginDir under the repo name,
  // npm-installed plugins are keyed by package name — match either.
  const installedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const p of installed) keys.add(p.name)
    for (const p of local) {
      keys.add(p.name)
      const base = p.path.split(/[\\/]/).pop()
      if (base) keys.add(base)
    }
    return keys
  }, [installed, local])

  const isInstalled = (repo: MarketRepo): boolean => installedKeys.has(repo.repo) || installedKeys.has(repo.fullName)

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    const repos = data?.repos ?? []
    if (!q) return repos
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q) ||
        r.topics.some((tp) => tp.toLowerCase().includes(q))
    )
  }, [data, q])

  const totalPages = Math.min(MAX_PAGE, Math.max(1, Math.ceil((data?.totalCount ?? 0) / PER_PAGE)))
  const goto = (p: number): void => {
    setPage(p)
    void load(p)
  }

  return (
    <div className="space-y-4">
      {/* toolbar: search + count + refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-[200px] flex-1"
          placeholder={t('market.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
          {t('market.total', { count: data?.totalCount ?? 0 })}
        </span>
        <button className="btn btn-ghost btn-sm shrink-0" disabled={loading} onClick={() => void load(page)}>
          <RefreshIcon /> {t('market.refresh')}
        </button>
      </div>

      {error && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[12.5px]"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}
        >
          <span>
            {t('market.error')} {error}
          </span>
          <button className="btn btn-ghost btn-sm shrink-0" onClick={() => void load(page)}>
            {t('market.refresh')}
          </button>
        </div>
      )}

      {loading && !data ? (
        <div className="py-12 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
          {t('market.loading')}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
          {t('market.empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((r) => {
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
