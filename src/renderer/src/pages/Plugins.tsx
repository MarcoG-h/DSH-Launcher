import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { api, type PluginListResult } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { TrashIcon, PlayIcon, DownloadIcon, RefreshIcon } from '../lib/icons'
import { TaskConsole } from '../components/TaskConsole'
import { MarketTab } from '../components/MarketTab'
import { parseGitHubUrl } from '../../../shared/github'
import { RECOMMENDED_PLUGINS } from '../recommended'

export function Plugins(): JSX.Element {
  const { config, tasks } = useHarness()
  const { t } = useI18n()
  const [data, setData] = useState<PluginListResult | null>(null)
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'local' | 'market'>('local')
  const [selectedRec, setSelectedRec] = useState<Set<string>>(() => new Set(RECOMMENDED_PLUGINS.map((r) => r.name)))
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.listPlugins())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Keep the installed/local lists in sync with install/remove tasks in progress.
  useEffect(() => {
    const id = setInterval(() => {
      void load()
    }, 4000)
    return () => clearInterval(id)
  }, [load])

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const toggleSelected = (name: string): void => {
    setSelectedRec((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const installSelected = async (): Promise<void> => {
    const list = RECOMMENDED_PLUGINS.filter((r) => selectedRec.has(r.name))
    if (!list.length) return
    setBusy('install-recommended')
    setError(null)
    try {
      for (const rec of list) {
        const r = await api.downloadPlugin(rec.github)
        if (!r.ok && r.error) {
          setError(r.error)
          break
        }
      }
      await load()
      setSelectedRec(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Close an open plugin action menu on any outside click.
  useEffect(() => {
    if (!openMenu) return
    const close = (): void => setOpenMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openMenu])

  const gh = spec.trim() ? parseGitHubUrl(spec.trim()) : null

  const doInstall = (): void => {
    const target = spec.trim()
    if (!target) return
    if (gh) {
      // GitHub repo URL → download into pluginDir, then install from there.
      void run(`clone:${gh.repo}`, () => api.downloadPlugin(target))
    } else {
      void run(`install:${target}`, () => api.installPlugin(target))
    }
    setSpec('')
  }

  // Most recent clone / install tasks (covers both GitHub downloads and path/npm installs).
  const recentTasks = useMemo(
    () =>
      Object.values(tasks)
        .filter((t) => /^(clone|install):/.test(t.label))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3),
    [tasks]
  )

  const installed = data?.installed ?? []
  const local = data?.local ?? []

  return (
    <div className="p-5 space-y-5 max-w-[1000px]">
      <div className="flex items-center gap-2">
        <h2 className="text-[18px] font-semibold">{t('plugins.title')}</h2>
        <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
          profile: {config?.profile}
        </span>
      </div>

      {/* Tabs: local plugins / plugin market */}
      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {(['local', 'market'] as const).map((k) => (
          <button
            key={k}
            className="border-b-2 px-3 pb-2 text-[13px] font-medium transition-colors"
            style={{
              color: tab === k ? 'var(--accent)' : 'var(--muted)',
              borderColor: tab === k ? 'var(--accent)' : 'transparent'
            }}
            onClick={() => setTab(k)}
          >
            {k === 'local' ? t('plugins.tabLocal') : t('plugins.tabMarket')}
          </button>
        ))}
      </div>

      {tab === 'market' ? (
        <MarketTab installed={installed} local={local} onRefresh={() => void load()} />
      ) : (
        <>
          {/* Install */}
          <div className="panel p-4">
        <label className="label">{t('plugins.installLabel')}</label>
        <div className="flex gap-2">
          <input
            className="input"
            placeholder="https://github.com/owner/dsh-some-plugin"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doInstall()
            }}
          />
          <button className="btn btn-primary shrink-0" disabled={!spec.trim() || busy !== null} onClick={doInstall}>
            {gh ? <DownloadIcon /> : <PlayIcon />} {gh ? t('plugins.downloadInstall') : t('plugins.install')}
          </button>
        </div>
        {gh ? (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--accent)' }}>
            {t('plugins.ghHint.pre')} <span className="mono">{config?.pluginDir}/{gh.repo}</span> {t('plugins.ghHint.tail', { profile: config?.profile ?? 'web' })}
          </p>
        ) : (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--muted)' }}>
            {t('plugins.specHint.pre')} <span className="mono">https://github.com/owner/repo</span>{t('plugins.specHint.sep')}<span className="mono">github:owner/repo</span>{t('plugins.specHint.tail')}
          </p>
        )}
        {error && <p className="mt-2 text-[12px]" style={{ color: 'var(--err)' }}>{error}</p>}
        {recentTasks.map((t) => (
          <div className="mt-3" key={t.label}>
            <TaskConsole task={t} />
          </div>
        ))}
      </div>

      {/* Installed */}
      <section>
        <div className="flex items-center justify-between mb-2.5">
          <h3 className="section-title">{t('plugins.installedTitle', { count: installed.length })}</h3>
        </div>
        {installed.length === 0 ? (
          <div className="space-y-3">
            <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
              {t('plugins.noInstalled')}
            </div>
            {/* Recommended plugins — shown on the empty state so new users see
                what's worth installing without hunting the market. One-click
                install; after uninstall the list just reappears (nothing is
                force-installed). */}
            <div className="card p-5" style={{ borderColor: 'var(--accent)' }}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span
                  className="badge"
                  style={{ color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}
                >
                  {t('plugins.recommendedTitle')}
                </span>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy !== null || selectedRec.size === 0}
                  onClick={() => void installSelected()}
                >
                  <DownloadIcon /> {t('plugins.installAllSelected')}
                </button>
              </div>
              <p className="text-[12px] mb-3" style={{ color: 'var(--muted)' }}>
                {t('plugins.recommendedHint')}
              </p>
              <div className="space-y-3">
                {RECOMMENDED_PLUGINS.map((rec) => (
                  <label key={rec.name} className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedRec.has(rec.name)}
                      onChange={() => toggleSelected(rec.name)}
                    />
                    <div className="min-w-0 flex-1">
                      <span className="mono text-[13px] font-semibold">{rec.name}</span>
                      <p className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                        {t(rec.descKey)}
                      </p>
                    </div>
                    <span
                      className="badge shrink-0 self-center"
                      style={{ color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}
                    >
                      @{rec.author}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-2.5">
            {installed.map((p) => (
              <div key={p.name} className="card p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="mono text-[13.5px] font-semibold">{p.name}</span>
                      {p.version && (
                        <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                          v{p.version}
                        </span>
                      )}
                      {p.enabled ? (
                        <span className="badge" style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }}>
                          <span className="badge-dot" style={{ background: 'var(--ok)' }} /> {t('plugins.enabled')}
                        </span>
                      ) : (
                        <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                          {t('plugins.disabled')}
                        </span>
                      )}
                      {!p.isBundle && (
                        <span className="badge" style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}>
                          {t('plugins.noBundle')}
                        </span>
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-1 text-[12.5px] leading-relaxed line-clamp-2" style={{ color: 'var(--muted)' }}>
                        {p.description}
                      </p>
                    )}
                    <div className="mt-1.5 mono text-[11px]" style={{ color: 'var(--muted)' }}>
                      {p.localPath ?? p.spec}
                    </div>
                  </div>
                  <div className="relative flex items-center gap-1.5 shrink-0">
                    {p.enabled ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy !== null}
                        onClick={() => void run(`toggle:${p.name}`, () => api.setPluginEnabled(p.name, false))}
                      >
                        {t('plugins.disable')}
                      </button>
                    ) : (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy !== null}
                        onClick={() => void run(`toggle:${p.name}`, () => api.setPluginEnabled(p.name, true))}
                      >
                        {t('plugins.enable')}
                      </button>
                    )}
                    <div className="flex items-center">
                      <button
                        className="btn btn-danger btn-sm"
                        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                        disabled={busy !== null}
                        title={t('plugins.uninstallTitle')}
                        onClick={() => {
                          if (window.confirm(t('plugins.confirmRemove', { name: p.name }))) {
                            void run(`remove:${p.name}`, () => api.removePlugin(p.name))
                          }
                        }}
                      >
                        <TrashIcon /> {t('plugins.uninstall')}
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: '1px solid rgba(255,255,255,0.25)', fontSize: 16, padding: '0 5px' }}
                        disabled={busy !== null}
                        title={t('plugins.update')}
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpenMenu(openMenu === p.name ? null : p.name)
                        }}
                      >
                        ▾
                      </button>
                    </div>
                    {openMenu === p.name && (
                      <div className="absolute right-0 top-full mt-1 z-20 card p-1">
                        <button
                          className="btn btn-ghost btn-sm w-full"
                          disabled={busy !== null}
                          onClick={(e) => {
                            e.stopPropagation()
                            setOpenMenu(null)
                            void run(`update:${p.name}`, () => api.updatePlugin(p.name))
                          }}
                          style={{ color: 'var(--warn)' }}
                        >
                          <RefreshIcon /> {t('plugins.update')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Local available */}
      <section>
        <div className="flex items-center justify-between mb-2.5">
          <h3 className="section-title">{t('plugins.localTitle', { count: local.length })}</h3>
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {config?.pluginDir}
          </span>
        </div>
        {local.length === 0 ? (
          <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
            {t('plugins.noLocal', { dir: config?.pluginDir ?? '' })}
          </div>
        ) : (
          <div className="grid gap-2.5">
            {local.map((p) => (
              <div key={p.name} className="card p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="mono text-[13.5px] font-semibold">{p.name}</span>
                      {p.version && (
                        <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                          v{p.version}
                        </span>
                      )}
                      {p.status === 'enabled' ? (
                        <span className="badge" style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }}>
                          <span className="badge-dot" style={{ background: 'var(--ok)' }} /> {t('plugins.enabled')}
                        </span>
                      ) : p.status === 'installed' ? (
                        <span className="badge" style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}>
                          {t('plugins.installedNotEnabled')}
                        </span>
                      ) : (
                        <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                          {t('plugins.notInstalled')}
                        </span>
                      )}
                      {p.isBundle ? (
                        <span className="badge" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                          bundle
                        </span>
                      ) : (
                        <span className="badge" style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}>
                          {t('plugins.noBundle')}
                        </span>
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-1 text-[12.5px] leading-relaxed line-clamp-2" style={{ color: 'var(--muted)' }}>
                        {p.description}
                      </p>
                    )}
                    <div className="mt-1.5 mono text-[11px]" style={{ color: 'var(--muted)' }}>
                      {p.path}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {p.status === 'not-installed' ? (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={busy !== null}
                        onClick={() => void run(`install:${p.path}`, () => api.installPlugin(p.path))}
                      >
                        <PlayIcon /> {t('plugins.install')}
                      </button>
                    ) : p.status === 'installed' ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy !== null}
                        onClick={() => void run(`toggle:${p.name}`, () => api.setPluginEnabled(p.name, true))}
                      >
                        {t('plugins.enable')}
                      </button>
                    ) : (
                      <span className="btn btn-ghost btn-sm" style={{ cursor: 'default' }}>
                        {t('plugins.enabled')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
        <p className="pt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
          {t('plugins.restartHint')}
        </p>
        </>
      )}
    </div>
  )
}
