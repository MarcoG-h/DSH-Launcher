import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api, type PluginListResult, type PluginMatrixResult, type PluginMatrixRow, type PluginMeta } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useBackdropClose } from '../hooks/useBackdropClose'
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
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [tab, setTabState] = useState<'local' | 'market'>(() => {
    try { return localStorage.getItem('dsh-launcher-plugins-tab') === 'local' ? 'local' : 'market' } catch { return 'market' }
  })
  const setTab = (k: 'local' | 'market'): void => {
    setTabState(k)
    try { localStorage.setItem('dsh-launcher-plugins-tab', k) } catch { /* 忽略 */ }
  }
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
    // 支持并行:多个安装/操作可同时进行,busy 是「进行中任务」的集合,而非互斥锁。
    setBusy((prev) => new Set(prev).add(label))
    setError(null)
    try {
      await fn()
      await loadMatrix()
      await loadList()
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
    if (!await api.confirm(t('plugins.removeManyConfirm', { count: names.length }))) return
    setBusy(new Set(['remove-many']))
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
      setBusy(new Set())
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

  const removeManyTask = tasks['remove-many']
  const rows = matrix?.rows ?? []
  const columns = matrix?.columns ?? []
  const cells = matrix?.cells ?? {}
  // 分组:本地持有的插件(DSH-Plugin 有源码)vs 直装插件(dsh plugin add 装的,可折叠)。
  const localOwnedRows = rows.filter((r) => r.path !== '')
  const directOnlyRows = rows.filter((r) => r.path === '')
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
          // 下载/更新后同时刷新列表与矩阵,否则新下载的插件不会出现在本地库(矩阵)。
          onRefresh={() => { void loadList(); void loadMatrix() }}
        />
      ) : (
        <>
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
                    <button className="btn btn-danger btn-sm" disabled={busy.size > 0} onClick={() => void doRemoveMany()}>
                      <TrashIcon /> {t('plugins.removeSelected')}
                    </button>
                  </>
                )}
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  {config?.pluginDir}
                </span>
              </div>
            </div>

            {removeManyTask?.running && (
              <div className="mb-2">
                <TaskConsole task={removeManyTask} />
              </div>
            )}

            {localOwnedRows.length === 0 && directOnlyRows.length === 0 ? (
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
                    {localOwnedRows.map((row) => (
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
              <details className="mt-3">
                <summary className="cursor-pointer select-none text-[12px] font-medium" style={{ color: 'var(--muted)' }}>
                  {t('plugins.directGroup', { count: directOnlyRows.length })}
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full border-collapse text-[12.5px]">
                    <thead>
                      <tr>
                        <th className="text-left font-medium px-3 py-2 border-b" style={{ color: 'var(--muted)', borderColor: 'var(--border)', minWidth: 200 }}>
                          {t('plugins.matrix.plugin')}
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
                            <button className="w-full text-left cursor-pointer select-none" title={t('plugins.matrix.clickForDetail')} onClick={() => setDetail(row)}>
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
                                onOpen={(e) => { e.stopPropagation(); setMenu(menu?.rowName === row.name && menu?.colId === c.id ? null : { rowName: row.name, colId: c.id }) }}
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

            <p className="pt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
              {t('plugins.matrix.hint')}
            </p>
          </section>

          {/* 安装插件卡片:放在矩阵最下面 */}
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
              <button className="btn btn-primary shrink-0" disabled={!spec.trim() || busy.size > 0} onClick={doInstall}>
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
          onUpdated={() => {
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
  const { t } = useI18n()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [menuUp, setMenuUp] = useState(false)
  // 菜单打开时测量:若向下展开会超出可视底部(滚动容器或视口),改为向上展开,
  // 避免底部行的操作菜单被容器裁掉一半、要拖滚动条才看得到。
  useLayoutEffect(() => {
    if (!menuOpen) return
    const el = wrapRef.current
    if (!el) return
    const menu = el.querySelector<HTMLElement>('.matrix-cell-menu')
    const h = menu?.offsetHeight ?? 0
    const r = el.getBoundingClientRect()
    // 找最近的滚动容器(overflow auto/scroll 的祖先),按它的可视底部判断;
    // 没找到则用视口底部。取两者较小值,确保任何一边都不被裁切。
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
    ? t('plugins.matrix.removing')
    : installing
      ? t('plugins.matrix.installing')
      : status === 'enabled'
        ? t('plugins.matrix.enabled')
        : status === 'installed'
          ? t('plugins.matrix.installed')
          : t('plugins.matrix.notInstalled')

  const items: { key: string; label: string; danger?: boolean; fn: () => Promise<unknown> }[] = []
  if (status === 'not-installed') {
    items.push({
      key: 'enable',
      label: t('plugins.matrix.enable'),
      // 直装行(path 为空)没有本地目录可安装,用其安装 spec 在原实例外复装。
      fn: () => api.installPlugin(colId, installSourceFor(row), row.name)
    })
  } else if (status === 'installed') {
    // 已安装未启用:纯启用(不重装),或从该实例移除。
    items.push({
      key: 'enable',
      label: t('plugins.matrix.enable'),
      fn: () => api.enablePlugin(colId, row.name)
    })
    items.push({
      key: 'remove',
      label: t('plugins.matrix.remove'),
      danger: true,
      // 卸载 = 真正从该实例移除依赖(回到「未安装」),不弹确认框。
      // 停用(enabled→禁用)才是只移除挂载;卸载应清掉依赖。
      fn: () => api.uninstallPlugin(colId, row.name)
    })
  } else {
    items.push({
      key: 'disable',
      label: t('plugins.matrix.disable'),
      danger: true,
      // 停用 = 只移除挂载(本地源码保留),无害操作,不弹确认框。
      fn: () => api.disablePlugin(colId, row.name)
    })
    items.push({
      key: 'reinstall',
      label: t('plugins.matrix.reinstall'),
      fn: () => api.updatePlugin(colId, row.name)
    })
  }

  return (
    <div ref={wrapRef} className="relative inline-block">
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
  const { t } = useI18n()
  const { tasks } = useHarness()
  // 更新任务进度(主进程 taskLine/taskProgress 广播的 `update-local:<basename>` 任务)。
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
    if (!await api.confirm(direct ? t('plugins.uninstallAllConfirm', { name: row.displayName }) : t('plugins.removeFromLibraryConfirm', { name: row.displayName }))) return
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

  const updateLocal = async (): Promise<void> => {
    if (!await api.confirm(t('plugins.updateLocalConfirm', { name: row.displayName }))) return
    setUpdating(true)
    setErr(null)
    try {
      const r = await api.updateLocalPlugin(row.path)
      if (!r.ok) {
        setErr(r.error ?? t('plugins.updateLocalFailed'))
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

  // 点击背景才关闭。内层按下、在背景松开(拖选文本后鼠标滑出窗口)时,click 会落在
  // 背景上——用 mousedown 起始位置判定:只有按下也起始于背景才关闭,避免拖选误触。
  const backdrop = useBackdropClose(onClose)

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }} onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick}>
      <div className="card p-5 w-full max-w-[520px] max-h-[85vh] overflow-y-auto" onMouseDown={backdrop.contentMouseDown} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold leading-tight">{t('plugins.detail.title')}</h3>
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
          <div className="flex items-center justify-between gap-2 col-span-2">
            <span className="shrink-0" style={{ color: 'var(--muted)' }}>
              {t('plugins.detail.path')}
            </span>
            <div className="flex items-center gap-1 min-w-0">
              <span className="mono truncate select-text" title={row.path || row.spec}>
                {row.path || row.spec || '—'}
              </span>
              {(row.path || row.spec) && (
                <CopyButton text={row.path || row.spec || ''} title={t('plugins.copyPath')} />
              )}
            </div>
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

        {updateTask && <div className="mt-3"><TaskConsole task={updateTask} /></div>}

        <div className="flex items-center justify-between gap-2 mt-4">
          <div className="flex items-center gap-2">
            {/* 本地持有插件可更新:卸载全部实例 + 从 GitHub 拉取最新 */}
            {row.path !== '' && (
              <button className="btn btn-ghost" disabled={updating} onClick={() => void updateLocal()}>
                <RefreshIcon /> {updating ? t('plugins.updatingLocal') : t('plugins.updateLocal')}
              </button>
            )}
            <button className="btn btn-danger" disabled={removing} onClick={() => void removeFromLibrary()}>
              {row.path === '' ? t('plugins.uninstallAll') : t('plugins.removeFromLibrary')}
            </button>
          </div>
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
