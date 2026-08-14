import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { api, type PluginListResult } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { TrashIcon, PlayIcon } from '../lib/icons'
import { TaskConsole } from '../components/TaskConsole'

export function Plugins(): JSX.Element {
  const { config, tasks } = useHarness()
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

  const doInstall = (): void => {
    const target = spec.trim()
    if (!target) return
    void run(`install:${target}`, () => api.installPlugin(target))
    setSpec('')
  }

  const installTask = useMemo(() => {
    if (!data) return undefined
    for (const p of data.installed) {
      const t = tasks[`install:${p.spec}`]
      if (t && (t.running || t.lines.length > 0)) return t
    }
    return undefined
  }, [tasks, data])

  const installed = data?.installed ?? []
  const local = data?.local ?? []

  return (
    <div className="p-5 space-y-5 max-w-[1000px]">
      <div className="flex items-center gap-2">
        <h2 className="text-[18px] font-semibold">插件管理</h2>
        <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
          profile: {config?.profile}
        </span>
      </div>

      {/* Install */}
      <div className="panel p-4">
        <label className="label">安装插件 — 本地路径 或 npm 包名</label>
        <div className="flex gap-2">
          <input
            className="input"
            placeholder="如 C:/Users/Marco/DSH-Plugin/dsh-side-panel 或 @scope/plugin"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doInstall()
            }}
          />
          <button className="btn btn-primary shrink-0" disabled={!spec.trim() || busy !== null} onClick={doInstall}>
            <PlayIcon /> 安装
          </button>
        </div>
        {error && <p className="mt-2 text-[12px]" style={{ color: 'var(--err)' }}>{error}</p>}
        {installTask && (
          <div className="mt-3">
            <TaskConsole task={installTask} />
          </div>
        )}
      </div>

      {/* Installed */}
      <section>
        <div className="flex items-center justify-between mb-2.5">
          <h3 className="section-title">已安装 · {installed.length}</h3>
        </div>
        {installed.length === 0 ? (
          <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
            该 profile 还没有安装外部插件。
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
                          <span className="badge-dot" style={{ background: 'var(--ok)' }} /> 已启用
                        </span>
                      ) : (
                        <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                          未启用
                        </span>
                      )}
                      {!p.isBundle && (
                        <span className="badge" style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}>
                          无 bundle
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
                        停用
                      </button>
                    ) : (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy !== null}
                        onClick={() => void run(`toggle:${p.name}`, () => api.setPluginEnabled(p.name, true))}
                      >
                        启用
                      </button>
                    )}
                    <button
                      className="btn btn-danger btn-sm"
                      disabled={busy !== null}
                      title="卸载插件"
                      onClick={() => {
                        if (window.confirm(`卸载插件 ${p.name}?`)) {
                          void run(`remove:${p.name}`, () => api.removePlugin(p.name))
                        }
                      }}
                    >
                      <TrashIcon /> 卸载
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
          <h3 className="section-title">本地可用 · {local.length}</h3>
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {config?.pluginDir}
          </span>
        </div>
        {local.length === 0 ? (
          <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
            未在插件目录发现插件({config?.pluginDir})。
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
                          <span className="badge-dot" style={{ background: 'var(--ok)' }} /> 已启用
                        </span>
                      ) : p.status === 'installed' ? (
                        <span className="badge" style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}>
                          已安装 · 未启用
                        </span>
                      ) : (
                        <span className="badge" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                          未安装
                        </span>
                      )}
                      {p.isBundle ? (
                        <span className="badge" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                          bundle
                        </span>
                      ) : (
                        <span className="badge" style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}>
                          无 bundle
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
                        <PlayIcon /> 安装
                      </button>
                    ) : p.status === 'installed' ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy !== null}
                        onClick={() => void run(`toggle:${p.name}`, () => api.setPluginEnabled(p.name, true))}
                      >
                        启用
                      </button>
                    ) : (
                      <span className="btn btn-ghost btn-sm" style={{ cursor: 'default' }}>
                        已启用
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
