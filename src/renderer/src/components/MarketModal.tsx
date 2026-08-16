import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, MouseEvent } from 'react'
import { api, type CmdResult, type MarketReadme, type MarketRepo, type PluginSubPackage } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { renderMarkdown } from '../lib/markdown'
import { TaskConsole } from './TaskConsole'
import { DownloadIcon } from '../lib/icons'

function fmtDate(iso: string, lang: 'zh' | 'en'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

interface Props {
  repo: MarketRepo
  isInstalled: boolean
  onClose: () => void
  onInstalled: () => void
}

/** Detail modal for a market plugin: metadata + README + one-click install. */
export function MarketModal({ repo, isInstalled, onClose, onInstalled }: Props): JSX.Element {
  const { t, lang } = useI18n()
  const { tasks } = useHarness()
  const readmeRef = useRef<HTMLDivElement>(null)
  const [readme, setReadme] = useState<MarketReadme | null>(null)
  const [readmeLoading, setReadmeLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  // When a repo ships several plugin packages in subdirectories, the first
  // install returns a list instead of installing; the chooser below picks one.
  const [pendingPkgs, setPendingPkgs] = useState<PluginSubPackage[] | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setReadmeLoading(true)
    void api.fetchMarketReadme(repo.owner, repo.repo).then((r) => {
      if (!alive) return
      setReadme(r)
      setReadmeLoading(false)
    })
    return () => {
      alive = false
    }
  }, [repo.owner, repo.repo])

  // The install flow produces a `clone:<repo>` task (clone into pluginDir) then
  // an `install:<path>` task; surface whichever is current so the user sees progress.
  const marketTask = useMemo(() => {
    const clone = tasks[`clone:${repo.repo}`]
    if (clone) return clone
    return Object.values(tasks)
      .filter((task) => task.label.startsWith('install:') && task.running)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }, [tasks, repo.repo])

  const doInstall = async (subdir?: string): Promise<void> => {
    setInstalling(true)
    setInstallError(null)
    try {
      const r: CmdResult = await api.downloadPlugin(`github:${repo.fullName}`, subdir)
      if (r.ok) {
        setPendingPkgs(null)
        onInstalled()
      } else if (r.packages?.length) {
        // Multi-package repo: the clone succeeded but we need the user to pick.
        setPendingPkgs(r.packages)
      } else if (r.error) {
        setInstallError(r.error)
      }
    } finally {
      setInstalling(false)
    }
  }

  // Route README clicks: `#anchor` scrolls in-page; anything else is confirmed
  // in a native dialog and opened via the system browser. Never lets the
  // launcher window navigate to the link.
  const onReadmeClick = (e: MouseEvent<HTMLDivElement>): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      e.preventDefault()
      const id = href.slice(1)
      const target = id
        ? readmeRef.current?.querySelector(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`)
        : null
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    e.preventDefault()
    void api.confirmOpenExternal(href)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}
    >
      <div
        className="panel flex max-h-[80vh] w-full max-w-[680px] flex-col p-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start gap-3 border-b p-4" style={{ borderColor: 'var(--border)' }}>
          <img
            src={repo.avatarUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full"
            style={{ background: 'var(--bg-soft)' }}
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono text-[15px] font-semibold">{repo.fullName}</span>
              <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                ⭐ {repo.stars}
              </span>
              {repo.language && (
                <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                  {repo.language}
                </span>
              )}
              {isInstalled && (
                <span className="badge" style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }}>
                  {t('market.installed')}
                </span>
              )}
            </div>
            {repo.description && (
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                {repo.description}
              </p>
            )}
            {repo.topics.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {repo.topics.slice(0, 8).map((tp) => (
                  <span key={tp} className="badge" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                    {tp}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button className="btn btn-ghost btn-sm shrink-0" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          {!pendingPkgs && (
            <button className="btn btn-primary btn-sm" disabled={isInstalled || installing || marketTask?.running} onClick={() => void doInstall()}>
              <DownloadIcon /> {isInstalled ? t('market.installed') : installing || marketTask?.running ? '…' : t('market.install')}
            </button>
          )}
          <a className="btn btn-ghost btn-sm" href={repo.htmlUrl} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
          <span className="ml-auto text-[11.5px]" style={{ color: 'var(--muted)' }}>
            {t('market.updated', { date: fmtDate(repo.updatedAt, lang) })} · {repo.forks} forks
          </span>
        </div>

        {/* subpackage chooser: the repo ships several installable packages in subdirectories */}
        {pendingPkgs && (
          <div className="space-y-1.5 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <p className="text-[12.5px] font-medium">{t('market.multiPackage')}</p>
            {pendingPkgs.map((p) => (
              <button
                key={p.path}
                className="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors"
                style={{ borderColor: 'var(--border)' }}
                disabled={installing}
                onClick={() => void doInstall(p.path)}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
              >
                <span className="min-w-0">
                  <span className="mono block truncate text-[12.5px] font-semibold">{p.name}</span>
                  <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                    {p.path}/
                  </span>
                </span>
                <span className="btn btn-primary btn-sm shrink-0">{t('market.installSub')}</span>
              </button>
            ))}
          </div>
        )}

        {/* install error surfaced from downloadPlugin (e.g. repo has no dsh plugin) */}
        {installError && (
          <div className="border-b px-4 py-3 text-[12.5px]" style={{ borderColor: 'var(--border)', color: 'var(--warn)' }}>
            {installError}
          </div>
        )}

        {/* install task progress */}
        {marketTask && (
          <div className="px-4 pt-3">
            <TaskConsole task={marketTask} />
          </div>
        )}

        {/* README */}
        <div className="flex-1 overflow-auto p-4">
          <h3 className="section-title mb-2">{t('market.readmeTitle')}</h3>
          {readmeLoading ? (
            <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
              {t('market.readmeLoading')}
            </p>
          ) : readme?.ok ? (
            <div
              ref={readmeRef}
              className="market-md"
              onClick={onReadmeClick}
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(readme.text ?? '', {
                  raw: `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/`,
                  blob: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/`
                })
              }}
            />
          ) : (
            <p className="text-[12.5px]" style={{ color: 'var(--warn)' }}>
              {readme?.error ?? t('market.readmeFailed')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
