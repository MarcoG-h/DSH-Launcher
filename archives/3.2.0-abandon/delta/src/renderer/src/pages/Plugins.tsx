import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api, type PluginMatrixResult, type PluginMatrixRow, type PluginMeta } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { useI18n } from '../i18n'
import { TrashIcon, PlayIcon, DownloadIcon, RefreshIcon, PlusIcon } from '../lib/icons'
import { TaskConsole } from '../components/TaskConsole'
import { CopyButton } from '../components/CopyButton'
import { parseGitHubUrl } from '../../../shared/github'

/** Where a cell's action menu is open. */
interface CellMenu {
  rowName: string
  colId: string
}

/** 插件「本地矩阵」主面板(统一扩展页的插件类目)。行 = 本地插件,列 = 实例。 */
export function PluginMatrixSection(): JSX.Element {
  const { config, tasks, activeInstanceId, states } = useHarness()
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const [matrix, setMatrix] = useState<PluginMatrixResult | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<CellMenu | null>(null)
  const [detail, setDetail] = useState<PluginMatrixRow | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const loadMatrix = useCallback(async () => {
    try {
      setMatrix(await api.listPluginMatrix())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void loadMatrix()
  }, [loadMatrix])

  // Poll so install/enable tasks (which restart the harness and settle later)
  // and the per-instance plugin set converge without manual refresh.
  useEffect(() => {
    const id = setInterval(() => {
      void loadMatrix()
    }, 4000)
    return () => clearInterval(id)
  }, [loadMatrix])

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy((prev) => new Set(prev).add(label))
    setError(null)
    try {
      await fn()
      await loadMatrix()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(label)
        return next
      })
    }
  }

  // Close an open cell menu on any outside click.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menu])

  /** 批量移除选中的本地插件:一次确认,逐个删除源码并同步卸载所有实例中的这些插件。 */
  const doRemoveMany = async (): Promise<void> => {
    const names = [...selected]
    if (!names.length) return
    if (!await api.confirm(lang === 'en' ? `Remove ${names.length} selected plugin(s) from the local library? Source folders are deleted and they are uninstalled from every instance. This cannot be undone.` : `从本地库移除选中的 ${names.length} 个插件?将删除本地源码并同步卸载所有实例中的这些插件,此操作不可恢复。`)) return
    setBusy(new Set(['remove-many']))
    setError(null)
    try {
      const r = await api.removeFromLibraryMany(names)
      if (r.warnings?.length) setError(r.warnings.join(' · '))
      setSelected(new Set())
      await loadMatrix()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(new Set())
    }
  }

  const rows = matrix?.rows ?? []
  const columns = matrix?.columns ?? []
  const cells = matrix?.cells ?? {}
  // 分组:本地持有的插件(DSH-Plugin 有源码)vs 直装插件(dsh plugin add 装的,可折叠)。
  const localOwnedRows = rows.filter((r) => r.path !== '')
  const directOnlyRows = rows.filter((r) => r.path === '')
  // 可批量删除的行 = 本地库插件;直装行(path 为空)不在本地库,不可勾选。
  const removableRows = useMemo(() => rows.filter((r) => r.path !== ''), [rows])

  // Keep the selection in sync with the live row list.
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

  const removeManyTask = tasks['remove-many']

  return (
    <div className="space-y-4">
      {/* 矩阵小工具栏:左 = 本地操作,右 = 手动添加(弹窗) */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[14px] font-semibold">
            {L('本地插件', 'Local plugins')} · {rows.length}
          </h3>
          {columns.length > 0 && (
            <span className="badge" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
              {L('实例', 'Instances')}: {columns.length}
            </span>
          )}
          <button className="btn btn-ghost btn-sm" disabled={busy.size > 0} onClick={() => void loadMatrix()}>
            <RefreshIcon /> {L('刷新', 'Refresh')}
          </button>
          {selected.size > 0 && (
            <>
              <span className="text-[11px]" style={{ color: 'var(--accent)' }}>
                {L(`${selected.size} 个已选`, `${selected.size} selected`)}
              </span>
              <button className="btn btn-danger btn-sm" disabled={busy.size > 0} onClick={() => void doRemoveMany()}>
                <TrashIcon /> {L('批量移除', 'Remove selected')}
              </button>
            </>
          )}
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>
          <PlusIcon /> {L('安装插件', 'Install plugin')}
        </button>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-2 rounded-lg px-3 py-2 text-[12px]" style={{ color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 12%, transparent)' }}>
          <p className="select-text break-all">{error}</p>
          <CopyButton text={error} />
        </div>
      )}

      {removeManyTask?.running && <TaskConsole task={removeManyTask} />}

      {localOwnedRows.length === 0 && directOnlyRows.length === 0 ? (
        <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
          {L(`未在插件目录发现插件(${config?.pluginDir ?? ''})。可从右侧「插件市场」下载或点「安装插件」直装。`, `No plugins found in the plugin directory (${config?.pluginDir ?? ''}). Download from the plugin market or install directly.`)}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                <th className="w-8 px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                  <input
                    type="checkbox"
                    checked={removableRows.length > 0 && selected.size === removableRows.length}
                    title={L('全选', 'Select all')}
                    onChange={(e) => setSelected(e.target.checked ? new Set(removableRows.map((r) => r.name)) : new Set())}
                  />
                </th>
                <th className="text-left font-medium px-3 py-2 border-b" style={{ color: 'var(--muted)', borderColor: 'var(--border)', minWidth: 200 }}>
                  {L('插件', 'Plugin')}
                </th>
                {columns.map((c) => {
                  const st = states[c.id]?.status
                  const colRunning = st === 'running' || st === 'external'
                  return (
                    <th
                      key={c.id}
                      className="text-center font-medium px-3 py-2 border-b whitespace-nowrap"
                      style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}
                      title={colRunning ? L('运行中', 'Running') : undefined}
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
              {localOwnedRows.map((row) => (
                <tr key={row.name} style={{ borderColor: 'var(--border)' }}>
                  <td className="w-8 px-3 py-2 border-b align-top" style={{ borderColor: 'var(--border)' }}>
                    <input
                      type="checkbox"
                      disabled={row.path === ''}
                      checked={selected.has(row.name)}
                      title={row.path === '' ? L('直装插件不可批量删除', 'Direct-installed plugin is not batch-removable') : row.displayName}
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
                  <td className="px-3 py-2 border-b align-top" style={{ borderColor: 'var(--border)' }}>
                    <button className="w-full text-left cursor-pointer select-none group" title={L('点击查看详情', 'Click for details')} onClick={() => setDetail(row)}>
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
                        installing={[...busy].some((l) => l.startsWith(`matrix:${row.name}:${c.id}:`))}
                        removing={[...busy].some((l) => l.startsWith(`matrix:${row.name}:${c.id}:`) && /:(remove|disable)$/.test(l))}
                        disabled={[...busy].some((l) => l.startsWith(`matrix:${row.name}:${c.id}:`))}
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

      {/* 直装插件(dsh plugin add 装的,如整合包/直装):与本地持有的插件分开,可折叠 */}
      {directOnlyRows.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none text-[12px] font-medium" style={{ color: 'var(--muted)' }}>
            {L(`直装插件(${directOnlyRows.length})`, `Directly installed (${directOnlyRows.length})`)}
          </summary>
          <div className="mt-2 overflow-x-auto rounded-xl" style={{ borderColor: 'var(--border)' }}>
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  <th className="text-left font-medium px-3 py-2 border-b" style={{ color: 'var(--muted)', borderColor: 'var(--border)', minWidth: 200 }}>
                    {L('插件', 'Plugin')}
                  </th>
                  {columns.map((c) => (
                    <th key={c.id} className="text-center font-medium px-3 py-2 border-b whitespace-nowrap" style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {directOnlyRows.map((row) => (
                  <tr key={row.name} style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-2 border-b align-top" style={{ borderColor: 'var(--border)' }}>
                      <button className="w-full text-left cursor-pointer select-none" title={L('点击查看详情', 'Click for details')} onClick={() => setDetail(row)}>
                        <span className="truncate text-[13px] font-semibold leading-tight" style={{ color: 'var(--text)' }}>{row.displayName}</span>
                        <div className="text-[11px] mt-0.5 line-clamp-1 leading-tight" style={{ color: 'var(--muted)' }}>
                          {row.remark || (row.version ? `v${row.version}` : '')}
                        </div>
                      </button>
                    </td>
                    {columns.map((c) => (
                      <td key={c.id} className="px-2 py-2 border-b text-center align-middle" style={{ borderColor: 'var(--border)' }}>
                        <MatrixCell
                          status={cells[row.name]?.[c.id] ?? 'not-installed'}
                          installing={[...busy].some((l) => l.startsWith(`matrix:${row.name}:${c.id}:`))}
                          removing={[...busy].some((l) => l.startsWith(`matrix:${row.name}:${c.id}:`) && /:(remove|disable)$/.test(l))}
                          disabled={[...busy].some((l) => l.startsWith(`matrix:${row.name}:${c.id}:`))}
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
        </details>
      )}

      <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
        {L('点击格子对该实例执行启用 / 停用 / 重装;点左侧插件名查看详情、改显示名/备注或从本地库移除。安装 / 重装插件后会自动重启实例使其生效。', 'Click a cell to enable / disable / reinstall for that instance; click a plugin name for details, rename, remark or remove from the library. Installing / reinstalling a plugin restarts the instance automatically.')}
      </p>

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
          }}
          onUpdated={() => {
            setDetail(null)
            void loadMatrix()
          }}
        />
      )}
      {addOpen && (
        <PluginInstallModal
          onClose={() => setAddOpen(false)}
          onInstalled={() => {
            setAddOpen(false)
            void loadMatrix()
          }}
        />
      )}
    </div>
  )
}

/** 矩阵「启用」直装行(path 为空,插件未在本地库、由 dsh plugin add 装进某实例)时的安装源。 */
function installSourceFor(row: PluginMatrixRow): string {
  if (row.path) return row.path
  return /^(github|file|link):/i.test(row.spec) ? row.spec : row.name
}

/** One matrix cell: a status badge that opens the per-instance action menu. */
function MatrixCell({
  status,
  disabled,
  installing,
  removing,
  menuOpen,
  onOpen,
  onClose,
  onAction,
  row,
  colId
}: {
  status: 'not-installed' | 'installed' | 'enabled'
  disabled: boolean
  installing: boolean
  removing: boolean
  menuOpen: boolean
  onOpen: (e: React.MouseEvent) => void
  onClose: () => void
  onAction: (label: string, fn: () => Promise<unknown>) => void
  row: PluginMatrixRow
  colId: string
}): JSX.Element {
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [menuUp, setMenuUp] = useState(false)
  useLayoutEffect(() => {
    if (!menuOpen) return
    const el = wrapRef.current
    if (!el) return
    const menu = el.querySelector<HTMLElement>('.matrix-cell-menu')
    const h = menu?.offsetHeight ?? 0
    const r = el.getBoundingClientRect()
    let container: HTMLElement | null = el.parentElement
    while (container) {
      const oy = window.getComputedStyle(container).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      container = container.parentElement
    }
    const viewBottom = window.innerHeight
    const containerBottom = container ? container.getBoundingClientRect().bottom : viewBottom
    setMenuUp(r.bottom + h > Math.min(viewBottom, containerBottom))
  }, [menuOpen])

  const style =
    status === 'enabled'
      ? { color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }
      : status === 'installed'
        ? { color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 14%, transparent)' }
        : { color: 'var(--muted)', background: 'var(--bg-soft)' }

  const label = removing
    ? L('卸载中', 'Removing')
    : installing
      ? L('安装中', 'Installing')
      : status === 'enabled'
        ? L('已启用', 'Enabled')
        : status === 'installed'
          ? L('未启用', 'Not enabled')
          : L('未安装', 'Not installed')

  const items: { key: string; label: string; danger?: boolean; fn: () => Promise<unknown> }[] = []
  if (status === 'not-installed') {
    items.push({
      key: 'enable',
      label: L('启用', 'Enable'),
      fn: () => api.installPlugin(colId, installSourceFor(row), row.name)
    })
  } else if (status === 'installed') {
    items.push({
      key: 'enable',
      label: L('启用', 'Enable'),
      fn: () => api.enablePlugin(colId, row.name)
    })
    items.push({
      key: 'remove',
      label: L('卸载', 'Remove'),
      danger: true,
      fn: () => api.uninstallPlugin(colId, row.name)
    })
  } else {
    items.push({
      key: 'disable',
      label: L('停用', 'Disable'),
      danger: true,
      fn: () => api.disablePlugin(colId, row.name)
    })
    items.push({
      key: 'reinstall',
      label: L('重装', 'Reinstall'),
      fn: () => api.updatePlugin(colId, row.name)
    })
  }

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button className="badge cursor-pointer select-none whitespace-nowrap" style={style} disabled={disabled} onClick={onOpen}>
        {status === 'enabled' && <span className="badge-dot mr-1" style={{ background: 'var(--ok)' }} />}
        {label}
      </button>
      {menuOpen && (
        <div
          className={`absolute right-0 z-20 card p-1 min-w-[110px] text-left matrix-cell-menu ${menuUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          onClick={(e) => e.stopPropagation()}
        >
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
  onRemoved,
  onUpdated
}: {
  row: PluginMatrixRow
  onClose: () => void
  onSaved: () => void
  onRemoved: () => void
  onUpdated: () => void
}): JSX.Element {
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const { tasks } = useHarness()
  const updateTask = tasks[`update-local:${row.path.split(/[\\/]/).pop() ?? ''}`]
  const [displayName, setDisplayName] = useState(row.displayName === row.name ? '' : row.displayName)
  const [remark, setRemark] = useState(row.remark ?? '')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [updating, setUpdating] = useState(false)
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
    if (!await api.confirm(direct ? L(`在所有实例卸载 ${row.displayName}?该插件未在本地库,将从每个实例移除。`, `Uninstall ${row.displayName} from all instances? This plugin is not in the local library.`) : L(`从本地库移除 ${row.displayName}?将删除本地源码并同步卸载所有实例中的该插件,此操作不可恢复。`, `Remove ${row.displayName} from the local library? This deletes the local source and uninstalls it from every instance.`))) return
    setRemoving(true)
    setErr(null)
    try {
      const r = await api.removeFromLibrary(row.name)
      if (!r.ok) {
        setErr(r.error ?? L('移除失败', 'Removal failed'))
        return
      }
      onRemoved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoving(false)
    }
  }

  const updateLocal = async (): Promise<void> => {
    if (!await api.confirm(L(`更新本地插件 ${row.displayName}?将先卸载所有实例中的该插件,再从 GitHub 拉取最新源码。`, `Update local plugin ${row.displayName}? It will be uninstalled from all instances first, then pulled from GitHub.`))) return
    setUpdating(true)
    setErr(null)
    try {
      const r = await api.updateLocalPlugin(row.path)
      if (!r.ok) {
        setErr(r.error ?? L('更新失败', 'Update failed'))
        return
      }
      onUpdated()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setUpdating(false)
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

  const backdrop = useBackdropClose(onClose)

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }} onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick}>
      <div className="card p-5 w-full max-w-[520px] max-h-[85vh] overflow-y-auto" onMouseDown={backdrop.contentMouseDown} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold leading-tight">{L('插件详情', 'Plugin details')}</h3>
            <div className="mono text-[12px] mt-0.5 select-text" style={{ color: 'var(--muted)', userSelect: 'text' }}>
              {row.name}
              {row.version ? ` · v${row.version}` : ''}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm shrink-0" onClick={onClose}>
            ✕
          </button>
        </div>

        {row.description && (
          <p className="text-[13px] leading-relaxed mb-4 select-text" style={{ color: 'var(--muted)', userSelect: 'text' }}>
            {row.description}
          </p>
        )}

        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4 text-[12px] select-text" style={{ userSelect: 'text' }}>
          <div className="flex justify-between gap-2">
            <span style={{ color: 'var(--muted)' }}>{L('版本', 'Version')}</span>
            <span className="mono truncate">{row.version || '—'}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span style={{ color: 'var(--muted)' }}>{L('类型', 'Type')}</span>
            <span>{row.isBundle ? 'bundle' : L('普通', 'plain')}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span style={{ color: 'var(--muted)' }}>{L('平台', 'Platform')}</span>
            <span className="mono truncate">{row.platform ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-2 col-span-2">
            <span className="shrink-0" style={{ color: 'var(--muted)' }}>
              {L('路径', 'Path')}
            </span>
            <div className="flex items-center gap-1 min-w-0">
              <span className="mono truncate select-text" title={row.path || row.spec}>
                {row.path || row.spec || '—'}
              </span>
              {(row.path || row.spec) && (
                <CopyButton text={row.path || row.spec || ''} title={L('复制路径', 'Copy path')} />
              )}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">{L('显示名称(留空使用包名)', 'Display name (leave empty to use package name)')}</label>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={row.name} />
          </div>
          <div>
            <label className="label">{L('备注(显示在插件名称下方)', 'Remark (shown under the plugin name)')}</label>
            <textarea className="input resize-none" rows={3} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder={L('例如:负责会话右键菜单…', 'e.g. handles the session context menu…')} />
          </div>
        </div>

        {err && (
          <div className="mt-3 flex items-start justify-between gap-2 text-[12px]" style={{ color: 'var(--err)' }}>
            <p className="select-text break-all">{err}</p>
            <CopyButton text={err} />
          </div>
        )}

        {updateTask && <div className="mt-3"><TaskConsole task={updateTask} /></div>}

        <div className="flex items-center justify-between gap-2 mt-4">
          <div className="flex items-center gap-2">
            {row.path !== '' && (
              <button className="btn btn-ghost" disabled={updating} onClick={() => void updateLocal()}>
                <RefreshIcon /> {updating ? L('更新中…', 'Updating…') : L('更新', 'Update')}
              </button>
            )}
            <button className="btn btn-danger" disabled={removing} onClick={() => void removeFromLibrary()}>
              {row.path === '' ? L('在所有实例卸载', 'Uninstall from all') : L('从本地库移除', 'Remove from library')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="text-[12px]" style={{ color: 'var(--ok)' }}>
                {L('已保存 ✓', 'Saved ✓')}
              </span>
            )}
            <button className="btn btn-ghost" onClick={onClose}>
              {L('关闭', 'Close')}
            </button>
            <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {L('保存', 'Save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 安装插件(URL / github / npm 包)表单 — 同时用于主面板「安装插件」弹窗与市场抽屉。 */
export function PluginInstallForm({ onInstalled }: { onInstalled?: () => void }): JSX.Element {
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const { config, tasks, activeInstanceId, instances } = useHarness()
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gh = parseGitHubUrl(spec.trim())

  const activeName = instances.find((i) => i.id === activeInstanceId)?.name ?? config?.profile ?? ''

  const recentTasks = useMemo(
    () =>
      Object.values(tasks)
        .filter((t) => /^(clone|install):/.test(t.label))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3),
    [tasks]
  )

  const doInstall = async (): Promise<void> => {
    const target = spec.trim()
    if (!target || busy) return
    setBusy(true)
    setError(null)
    try {
      if (gh) {
        await api.downloadPlugin(target, undefined, activeInstanceId)
      } else {
        await api.installPlugin(activeInstanceId, target)
      }
      setSpec('')
      onInstalled?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl p-3 space-y-2" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <label className="label">
        {L('安装插件 — GitHub 地址 / 本地路径 / npm 包', 'Install plugin — GitHub URL / local path / npm package')} · <span className="mono">{activeName}</span>
      </label>
      <div className="flex gap-2">
        <input
          className="input !py-1.5 text-[12px]"
          placeholder="https://github.com/owner/dsh-some-plugin"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doInstall()
          }}
        />
        <button className="btn btn-primary shrink-0" disabled={!spec.trim() || busy} onClick={() => void doInstall()}>
          {gh ? <DownloadIcon /> : <PlayIcon />} {gh ? L('下载到本地库', 'Download to library') : L('安装', 'Install')}
        </button>
      </div>
      {gh ? (
        <p className="text-[12px]" style={{ color: 'var(--accent)' }}>
          {L('将克隆到', 'Will clone into')} <span className="mono">{config?.pluginDir}/{gh.repo}</span> · {activeName}
        </p>
      ) : (
        <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
          {L('支持', 'Supports')} <span className="mono">https://github.com/owner/repo</span>、<span className="mono">github:owner/repo</span>、{L('本地路径或 npm 包名', 'a local path or npm package name')}
        </p>
      )}
      {error && (
        <div className="flex items-start justify-between gap-2 text-[12px]" style={{ color: 'var(--err)' }}>
          <p className="select-text break-all">{error}</p>
          <CopyButton text={error} />
        </div>
      )}
      {recentTasks.map((t) => (
        <div key={t.label}>
          <TaskConsole task={t} />
        </div>
      ))}
    </div>
  )
}

/** 主面板「安装插件」弹窗。 */
function PluginInstallModal({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }): JSX.Element {
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const backdrop = useBackdropClose(onClose)
  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }} onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick}>
      <div className="card p-4 w-full max-w-[560px] max-h-[85vh] overflow-y-auto" onMouseDown={backdrop.contentMouseDown} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-[15px] font-semibold">{L('安装插件', 'Install plugin')}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <PluginInstallForm
          onInstalled={() => {
            onInstalled()
          }}
        />
      </div>
    </div>
  )
}
