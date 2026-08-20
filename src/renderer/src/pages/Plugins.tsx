import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { api, type PluginListResult, type PluginMatrixResult, type PluginMatrixRow, type PluginMeta } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { TrashIcon, PlayIcon, DownloadIcon, RefreshIcon } from '../lib/icons'
import { TaskConsole } from '../components/TaskConsole'
import { MarketTab } from '../components/MarketTab'
import { CopyButton } from '../components/CopyButton'
import { parseGitHubUrl } from '../../../shared/github'

/** Where a cell's action menu is open. */
interface CellMenu {
  rowName: string
  colId: string
}

export function Plugins(): JSX.Element {
  const { config, tasks, activeInstanceId, states } = useHarness()
  const { t } = useI18n()
  const [matrix, setMatrix] = useState<PluginMatrixResult | null>(null)
  const [list, setList] = useState<PluginListResult | null>(null)
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'local' | 'market'>('market')
  const [menu, setMenu] = useState<CellMenu | null>(null)
  const [detail, setDetail] = useState<PluginMatrixRow | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const loadMatrix = useCallback(async () => {
    try {
      setMatrix(await api.listPluginMatrix())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadList = useCallback(async () => {
    try {
      setList(await api.listPlugins())
    } catch {
      /* market tab's installed-state refresh — non-fatal */
    }
  }, [])

  useEffect(() => {
    void loadMatrix()
    void loadList()
  }, [loadMatrix, loadList])

  // Poll so install/enable tasks (which restart the harness and settle later)
  // and the per-instance plugin set converge without manual refresh.
  useEffect(() => {
    const id = setInterval(() => {
      void loadMatrix()
      void loadList()
    }, 4000)
    return () => clearInterval(id)
  }, [loadMatrix, loadList])

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await loadMatrix()
      await loadList()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Close an open cell menu on any outside click.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menu])

  const gh = spec.trim() ? parseGitHubUrl(spec.trim()) : null

  const doInstall = (): void => {
    const target = spec.trim()
    if (!target) return
    if (gh) {
      // GitHub repo URL → download into the shared local library only; the user
      // enables it from the matrix below (instances are marked pending restart).
      void run(`clone:${gh.repo}`, () => api.downloadPlugin(target, undefined, activeInstanceId))
    } else {
      void run(`install:${target}`, () => api.installPlugin(activeInstanceId, target))
    }
    setSpec('')
  }

  /** 批量移除选中的本地插件:一次确认,逐个删除源码并同步卸载所有实例中的这些插件。 */
  const doRemoveMany = async (): Promise<void> => {
    const names = [...selected]
    if (!names.length) return
    if (!window.confirm(t('plugins.removeManyConfirm', { count: names.length }))) return
    setBusy('remove-many')
    setError(null)
    try {
      const r = await api.removeFromLibraryMany(names)
      if (r.warnings?.length) setError(r.warnings.join(' · '))
      setSelected(new Set())
      await loadMatrix()
      await loadList()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
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

  const rows = matrix?.rows ?? []
  const columns = matrix?.columns ?? []
  const cells = matrix?.cells ?? {}
  const installed = list?.installed ?? []
  const local = list?.local ?? []
  // 可批量删除的行 = 本地库插件;直装行(path 为空)不在本地库,批量删除会变成「全实例卸载」,不勾选。
  const removableRows = useMemo(() => rows.filter((r) => r.path !== ''), [rows])

  // Keep the selection in sync with the live row list: plugins removed elsewhere
  // (or polled away) shouldn't stay checked.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const names = new Set(rows.map((r) => r.name))
      let changed = false
      for (const n of prev) {
        if (!names.has(n)) {
          changed = true
          break
        }
      }
      return changed ? new Set([...prev].filter((n) => names.has(n))) : prev
    })
  }, [rows])

  const activeName = useMemo(
    () => matrix?.columns.find((c) => c.id === activeInstanceId)?.name ?? config?.profile ?? '',
    [matrix, activeInstanceId, config]
  )

  return (
    <div className="p-5 space-y-5 max-w-[1000px]">
      <div className="flex items-center gap-2">
        <h2 className="text-[18px] font-semibold">{t('plugins.title')}</h2>
        {columns.length > 0 && (
          <span className="badge" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
            {t('plugins.matrix.instances')}: {columns.length}
          </span>
        )}
      </div>

      {/* Tabs: plugin market / local plugins (matrix) */}
      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {(['market', 'local'] as const).map((k) => (
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
        <MarketTab
          installed={installed}
          local={local}
          // 矩阵里任意实例已启用的插件(dsh plugin add 直装可能在非活动实例),市场 tab 也应标为已下载。
          extraInstalledNames={Object.keys(cells)}
          onRefresh={() => void loadList()}
        />
      ) : (
        <>
          {/* Install into the active instance */}
          <div className="panel p-4">
            <label className="label">
              {t('plugins.installLabel')} · <span className="mono">{activeName}</span>
            </label>
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
                {t('plugins.ghHint.pre')} <span className="mono">{config?.pluginDir}/{gh.repo}</span>{' '}
                {t('plugins.ghHint.tail', { profile: activeName })}
              </p>
            ) : (
              <p className="mt-2 text-[12px]" style={{ color: 'var(--muted)' }}>
                {t('plugins.specHint.pre')} <span className="mono">https://github.com/owner/repo</span>
                {t('plugins.specHint.sep')}
                <span className="mono">github:owner/repo</span>
                {t('plugins.specHint.tail')}
              </p>
            )}
            {error && (
              <div className="mt-2 flex items-start justify-between gap-2 text-[12px]" style={{ color: 'var(--err)' }}>
                <p className="select-text break-all">{error}</p>
                <CopyButton text={error} />
              </div>
            )}
            {recentTasks.map((t) => (
              <div className="mt-3" key={t.label}>
                <TaskConsole task={t} />
              </div>
            ))}
          </div>

          {/* Plugin × instance matrix */}
          <section>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
              <h3 className="section-title">{t('plugins.matrix.title', { count: rows.length })}</h3>
              <div className="flex items-center gap-2">
                {selected.size > 0 && (
                  <>
                    <span className="text-[11px]" style={{ color: 'var(--accent)' }}>
                      {t('plugins.selected', { count: selected.size })}
                    </span>
                    <button className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => void doRemoveMany()}>
                      <TrashIcon /> {t('plugins.removeSelected')}
                    </button>
                  </>
                )}
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  {config?.pluginDir}
                </span>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
                {t('plugins.noLocal', { dir: config?.pluginDir ?? '' })}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      <th className="w-8 px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                        <input
                          type="checkbox"
                          checked={removableRows.length > 0 && selected.size === removableRows.length}
                          title={t('plugins.selectAll')}
                          onChange={(e) => setSelected(e.target.checked ? new Set(removableRows.map((r) => r.name)) : new Set())}
                        />
                      </th>
                      <th
                        className="text-left font-medium px-3 py-2 border-b"
                        style={{ color: 'var(--muted)', borderColor: 'var(--border)', minWidth: 200 }}
                      >
                        {t('plugins.matrix.plugin')}
                      </th>
                      {columns.map((c) => {
                        const st = states[c.id]?.status
                        const colRunning = st === 'running' || st === 'external'
                        return (
                          <th
                            key={c.id}
                            className="text-center font-medium px-3 py-2 border-b whitespace-nowrap"
                            style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}
                            title={colRunning ? t('status.running') : undefined}
                          >
                            <span
                              className={`badge-dot mr-1.5 inline-block align-middle${colRunning ? '' : ' opacity-30'}`}
                              style={{ background: colRunning ? 'var(--ok)' : 'var(--muted)' }}
                            />
                            <span className="align-middle">{c.name}</span>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.name} style={{ borderColor: 'var(--border)' }}>
                        <td className="w-8 px-3 py-2 border-b align-top" style={{ borderColor: 'var(--border)' }}>
                          <input
                            type="checkbox"
                            disabled={row.path === ''}
                            checked={selected.has(row.name)}
                            title={row.path === '' ? t('plugins.directRowUnselectable') : row.displayName}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              setSelected((prev) => {
                                const next = new Set(prev)
                                if (e.target.checked) next.add(row.name)
                                else next.delete(row.name)
                                return next
                              })
                            }}
                          />
                        </td>
                        {/* Concise left column — click for the full detail modal */}
                        <td className="px-3 py-2 border-b align-top" style={{ borderColor: 'var(--border)' }}>
                          <button
                            className="w-full text-left cursor-pointer select-none group"
                            title={t('plugins.matrix.clickForDetail')}
                            onClick={() => setDetail(row)}
                          >
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-[13px] font-semibold leading-tight" style={{ color: 'var(--text)' }}>
                                {row.displayName}
                              </span>
                            </div>
                            <div className="text-[11px] mt-0.5 line-clamp-1 leading-tight" style={{ color: 'var(--muted)' }}>
                              {row.remark || (row.version ? `v${row.version}` : '')}
                            </div>
                          </button>
                        </td>
                        {columns.map((c) => (
                          <td key={c.id} className="px-2 py-2 border-b text-center align-middle" style={{ borderColor: 'var(--border)' }}>
                            <MatrixCell
                              status={cells[row.name]?.[c.id] ?? 'not-installed'}
                              disabled={busy !== null}
                              menuOpen={menu?.rowName === row.name && menu?.colId === c.id}
                              onOpen={(e) => {
                                e.stopPropagation()
                                setMenu(menu?.rowName === row.name && menu?.colId === c.id ? null : { rowName: row.name, colId: c.id })
                              }}
                              onClose={() => setMenu(null)}
                              onAction={(label, fn) => void run(label, fn)}
                              row={row}
                              colId={c.id}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="pt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
              {t('plugins.matrix.hint')}
            </p>
          </section>

          <p className="pt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
            {t('plugins.restartHint')}
          </p>
        </>
      )}

      {detail && (
        <PluginDetailModal
          row={detail}
          onClose={() => setDetail(null)}
          onSaved={() => {
            setDetail(null)
            void loadMatrix()
          }}
          onRemoved={() => {
            setDetail(null)
            void loadMatrix()
            void loadList()
          }}
        />
      )}
    </div>
  )
}

/**
 * 矩阵「启用」直装行(path 为空,插件未在本地库、由 dsh plugin add 装进某实例)时的安装源:
 * github:/file:/link: 用原 spec;其余(semver range 如 ^1.0.0、裸包名)回退到包名,让
 * `dsh plugin add` 能识别。本地库行 path 非空,始终优先用本地目录。
 */
function installSourceFor(row: PluginMatrixRow): string {
  if (row.path) return row.path
  return /^(github|file|link):/i.test(row.spec) ? row.spec : row.name
}

/** One matrix cell: a status badge that opens the per-instance action menu. */
function MatrixCell({
  status,
  disabled,
  menuOpen,
  onOpen,
  onClose,
  onAction,
  row,
  colId
}: {
  status: 'not-installed' | 'enabled'
  disabled: boolean
  menuOpen: boolean
  onOpen: (e: React.MouseEvent) => void
  onClose: () => void
  onAction: (label: string, fn: () => Promise<unknown>) => void
  row: PluginMatrixRow
  colId: string
}): JSX.Element {
  const { t } = useI18n()

  const style =
    status === 'enabled'
      ? { color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }
      : { color: 'var(--muted)', background: 'var(--bg-soft)' }

  const label = status === 'enabled' ? t('plugins.matrix.enabled') : t('plugins.matrix.notInstalled')

  const items: { key: string; label: string; danger?: boolean; fn: () => Promise<unknown> }[] = []
  if (status === 'not-installed') {
    items.push({
      key: 'enable',
      label: t('plugins.matrix.enable'),
      // 直装行(path 为空)没有本地目录可安装,用其安装 spec 在原实例外复装。
      fn: () => api.installPlugin(colId, installSourceFor(row), row.name)
    })
  } else {
    items.push({
      key: 'disable',
      label: t('plugins.matrix.disable'),
      danger: true,
      fn: async () => {
        if (!window.confirm(t('plugins.disableConfirm', { name: row.name }))) return
        await api.disablePlugin(colId, row.name)
      }
    })
    items.push({
      key: 'reinstall',
      label: t('plugins.matrix.reinstall'),
      fn: () => api.updatePlugin(colId, row.name)
    })
  }

  return (
    <div className="relative inline-block">
      <button
        className="badge cursor-pointer select-none whitespace-nowrap"
        style={style}
        disabled={disabled}
        onClick={onOpen}
      >
        {status === 'enabled' && <span className="badge-dot mr-1" style={{ background: 'var(--ok)' }} />}
        {label}
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full mt-1 z-20 card p-1 min-w-[110px] text-left" onClick={(e) => e.stopPropagation()}>
          {items.map((it) => (
            <button
              key={it.key}
              className="btn btn-ghost btn-sm w-full justify-start"
              disabled={disabled}
              style={it.danger ? { color: 'var(--err)' } : undefined}
              onClick={() => {
                onClose()
                onAction(`matrix:${row.name}:${colId}:${it.key}`, it.fn)
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Detail modal: full plugin info + display-name override + remark + remove-from-library. */
function PluginDetailModal({
  row,
  onClose,
  onSaved,
  onRemoved
}: {
  row: PluginMatrixRow
  onClose: () => void
  onSaved: () => void
  onRemoved: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [displayName, setDisplayName] = useState(row.displayName === row.name ? '' : row.displayName)
  const [remark, setRemark] = useState(row.remark ?? '')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setDisplayName(row.displayName === row.name ? '' : row.displayName)
    setRemark(row.remark ?? '')
    setSaved(false)
    setErr(null)
  }, [row])

  const removeFromLibrary = async (): Promise<void> => {
    const direct = row.path === ''
    if (!window.confirm(direct ? t('plugins.uninstallAllConfirm', { name: row.displayName }) : t('plugins.removeFromLibraryConfirm', { name: row.displayName }))) return
    setRemoving(true)
    setErr(null)
    try {
      const r = await api.removeFromLibrary(row.name)
      // 主进程可能返回 ok:false(如 Windows 目录被运行中的实例占用)——此时展示
      // 具体原因,不当作移除成功。
      if (!r.ok) {
        setErr(r.error ?? t('plugins.removeFailed'))
        return
      }
      onRemoved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoving(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setErr(null)
    try {
      const meta: PluginMeta = { displayName: displayName.trim(), remark: remark.trim() }
      await api.setPluginMeta(row.name, meta)
      setSaved(true)
      setTimeout(onSaved, 400)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div className="card p-5 w-full max-w-[520px] max-h-[85vh] overflow-y-auto" style={{ background: 'var(--panel)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold leading-tight">{t('plugins.detail.title')}</h3>
            <div className="mono text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>
              {row.name}
              {row.version ? ` · v${row.version}` : ''}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm shrink-0" onClick={onClose}>
            ✕
          </button>
        </div>

        {row.description && (
          <p className="text-[13px] leading-relaxed mb-4" style={{ color: 'var(--muted)' }}>
            {row.description}
          </p>
        )}

        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4 text-[12px]">
          <div className="flex justify-between gap-2">
            <span style={{ color: 'var(--muted)' }}>{t('plugins.detail.version')}</span>
            <span className="mono truncate">{row.version || '—'}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span style={{ color: 'var(--muted)' }}>{t('plugins.detail.type')}</span>
            <span>{row.isBundle ? 'bundle' : t('plugins.noBundle')}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span style={{ color: 'var(--muted)' }}>{t('plugins.detail.platform')}</span>
            <span className="mono truncate">{row.platform ?? '—'}</span>
          </div>
          <div className="flex justify-between gap-2 col-span-2">
            <span className="shrink-0" style={{ color: 'var(--muted)' }}>
              {t('plugins.detail.path')}
            </span>
            <span className="mono truncate" title={row.path || row.spec}>
              {row.path || row.spec || '—'}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">{t('plugins.detail.displayName')}</label>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={row.name} />
          </div>
          <div>
            <label className="label">{t('plugins.detail.remark')}</label>
            <textarea
              className="input resize-none"
              rows={3}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder={t('plugins.detail.remarkPlaceholder')}
            />
          </div>
        </div>

        {err && (
          <div className="mt-3 flex items-start justify-between gap-2 text-[12px]" style={{ color: 'var(--err)' }}>
            <p className="select-text break-all">{err}</p>
            <CopyButton text={err} />
          </div>
        )}

        <div className="flex items-center justify-between gap-2 mt-4">
          <button className="btn btn-danger" disabled={removing} onClick={() => void removeFromLibrary()}>
            {row.path === '' ? t('plugins.uninstallAll') : t('plugins.removeFromLibrary')}
          </button>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="text-[12px]" style={{ color: 'var(--ok)' }}>
                {t('plugins.detail.saved')}
              </span>
            )}
            <button className="btn btn-ghost" onClick={onClose}>
              {t('plugins.detail.close')}
            </button>
            <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {t('plugins.detail.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
