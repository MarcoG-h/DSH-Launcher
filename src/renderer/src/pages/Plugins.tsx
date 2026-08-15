import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { api, type PluginListResult } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { TrashIcon, PlayIcon, DownloadIcon } from '../lib/icons'
import { TaskConsole } from '../components/TaskConsole'
import { parseGitHubUrl } from '../../../shared/github'

export function Plugins(): JSX.Element {
  const { config, tasks } = useHarness()
  const { t } = useI18n()
  const [data, setData] = useState<PluginListResult | null>(null)
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
          <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
            {t('plugins.noInstalled')}
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
                  <div className="flex items-center gap-1.5 shrink-0">
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
                    <button
                      className="btn btn-danger btn-sm"
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
    </div>
  )
}
