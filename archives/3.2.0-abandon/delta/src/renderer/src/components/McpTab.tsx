import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import { api, type DshInstance, type McpServer, type McpTransport } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { useI18n } from '../i18n'
import { RefreshIcon, PlusIcon, TrashIcon } from '../lib/icons'
import type { McpPreset } from './McpPresets'

type CellState = 'enabled' | 'disabled' | 'absent'

interface FormState {
  serverName: string
  transport: McpTransport
  url: string
  headers: string
  command: string
  args: string
  env: string
  cwd: string
}

const EMPTY_FORM: FormState = { serverName: '', transport: 'stdio', url: '', headers: '', command: '', args: '', env: '', cwd: '' }

function kvToLines(rows: { key: string; value: string }[]): string {
  return rows.map((r) => `${r.key}=${r.value}`).join('\n')
}
function linesToKv(text: string): { key: string; value: string }[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf('=')
    return i > 0 ? { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : { key: l, value: '' }
  })
}
function presetToForm(p: McpPreset): FormState {
  return {
    serverName: p.serverName,
    transport: p.transport,
    url: p.url ?? '',
    headers: p.headers && p.headers.length ? kvToLines(p.headers) : '',
    command: p.command ?? '',
    args: (p.args ?? []).join('\n'),
    env: p.env && p.env.length ? kvToLines(p.env) : '',
    cwd: p.cwd ?? ''
  }
}
function serverToForm(s: McpServer): FormState {
  return {
    serverName: s.serverName,
    transport: s.transport,
    url: s.url,
    headers: kvToLines(s.headers),
    command: s.command,
    args: s.args.join('\n'),
    env: kvToLines(s.env),
    cwd: s.cwd
  }
}

const cellStyle = (c: CellState): CSSProperties =>
  c === 'enabled'
    ? { color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }
    : c === 'disabled'
      ? { color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 14%, transparent)' }
      : { color: 'var(--muted)', background: 'var(--bg-soft)' }

const cellLabel = (c: CellState, L: (zh: string, en: string) => string): string =>
  c === 'enabled' ? L('已启用', 'Enabled') : c === 'disabled' ? L('未启用', 'Not enabled') : L('未分配', 'Not assigned')

/**
 * MCP 服务器矩阵主面板(统一扩展页 MCP 类目):行 = MCP 库(`mcp-library.json`),
 * 列 = 实例;单元格 = 该实例是否有该 serverName 的 loader 行及启停。空单元格点按 =
 * 把库配置写进该实例(分配+启用);库条目编辑/删除会自动同步/清理所有已分配实例。
 */
export function McpMatrixSection({
  presetDraft
}: {
  /** 右侧抽屉「一键使用」预置点添加后,把预置填进新建弹窗。 */
  presetDraft?: { preset: McpPreset; token: number } | null
}): JSX.Element {
  const { config, states } = useHarness()
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const visible = useMemo<DshInstance[]>(() => (config?.instances ?? []).filter((i) => i.enabled !== false), [config])
  const visibleKey = visible.map((i) => i.id).join(',')

  const [libRows, setLibRows] = useState<McpServer[]>([])
  const [perInst, setPerInst] = useState<Record<string, McpServer[]>>({})
  const [loader, setLoader] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<{ originalName?: string } | null>(null)
  const appliedToken = useRef<number | null>(null)

  // 抽屉预置「添加」→ 预填新建弹窗(存库)。
  useEffect(() => {
    if (!presetDraft || presetDraft.token === appliedToken.current) return
    appliedToken.current = presetDraft.token
    setEditing(null)
    setForm(presetToForm(presetDraft.preset))
    setFormOpen(true)
  }, [presetDraft])

  const loadAll = useCallback(async () => {
    const out: Record<string, McpServer[]> = {}
    const ld: Record<string, boolean> = {}
    let rows: McpServer[] = []
    try {
      rows = await api.listMcpLibrary()
    } catch {
      rows = []
    }
    await Promise.all(
      visible.map(async (inst) => {
        try {
          out[inst.id] = await api.listMcpServers(inst.id)
          ld[inst.id] = await api.mcpLoaderInstalled(inst.id)
        } catch {
          out[inst.id] = []
          ld[inst.id] = false
        }
      })
    )
    setLibRows(rows)
    setPerInst(out)
    setLoader(ld)
  }, [visibleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const mark = (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy((prev) => new Set(prev).add(key))
    setError(null)
    return fn()
      .then(loadAll)
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setBusy((prev) => {
        const n = new Set(prev)
        n.delete(key)
        return n
      }))
  }

  const cell = (serverName: string, instId: string): CellState => {
    const s = (perInst[instId] ?? []).find((x) => x.serverName === serverName)
    return s ? (s.enabled ? 'enabled' : 'disabled') : 'absent'
  }

  /** 实例列是否「已分配服务器但 loader 缺失」→ 列头 ⚠ + 汇总提示。 */
  const missingLoaderCols = visible.filter((i) => loader[i.id] === false && (perInst[i.id] ?? []).length > 0)

  const openNew = (): void => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const openEdit = (server: McpServer): void => {
    setEditing({ originalName: server.serverName })
    setForm(serverToForm(server))
    setFormOpen(true)
  }

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  const buildServer = (): McpServer => ({
    id: '',
    serverName: form.serverName.trim(),
    transport: form.transport,
    url: form.transport === 'streamable-http' ? form.url.trim() : '',
    headers: form.transport === 'streamable-http' ? linesToKv(form.headers) : [],
    command: form.transport === 'stdio' ? form.command.trim() : '',
    args: form.transport === 'stdio' ? form.args.split('\n').map((a) => a.trim()).filter(Boolean) : [],
    env: form.transport === 'stdio' ? linesToKv(form.env) : [],
    cwd: form.transport === 'stdio' ? form.cwd.trim() : '',
    enabled: true,
    extra: {}
  })

  const save = (): void => {
    void mark(`save:${form.serverName}`, async () => {
      await api.saveMcpLibrary(buildServer(), editing?.originalName)
      closeForm()
    })
  }

  const installLoaderFor = (instId: string): void => {
    void mark(`loader:${instId}`, async () => {
      const r = await api.installPlugin(instId, '@deepseek-ai/dsh-mcp-client')
      if (!r.ok) throw new Error(r.error || L('安装加载器失败', 'Failed to install loader'))
    })
  }

  const toggleCell = (serverName: string, instId: string, c: CellState): void => {
    void mark(`cell:${serverName}:${instId}`, async () => {
      // 需要「启用/分配」的路径都要求实例已装 loader(否则下次启动不生效甚至失败)。
      if (c !== 'enabled' && loader[instId] === false) {
        throw new Error(L(
          `该实例未安装 @deepseek-ai/dsh-mcp-client 加载器:先点下方「安装加载器」再分配。`,
          `This instance is missing the @deepseek-ai/dsh-mcp-client loader — install it below before assigning.`
        ))
      }
      if (c === 'enabled') {
        const row = (perInst[instId] ?? []).find((x) => x.serverName === serverName)
        if (!row) return
        await api.saveMcpServer(instId, { ...row, enabled: false }, row.id)
      } else if (c === 'disabled') {
        const row = (perInst[instId] ?? []).find((x) => x.serverName === serverName)
        if (!row) return
        await api.saveMcpServer(instId, { ...row, enabled: true }, row.id)
      } else {
        const lib = libRows.find((r) => r.serverName === serverName)
        if (!lib) return
        await api.saveMcpServer(instId, { ...lib, id: '', enabled: true }, undefined)
      }
    })
  }

  const deleteRow = (serverName: string): void => {
    void api
      .confirm(L(`删除 MCP 服务器「${serverName}」?将从 MCP 库移除,并从所有实例删除该服务器行。`, `Delete MCP server "${serverName}"? It is removed from the MCP library and every instance.`))
      .then((ok) => {
        if (ok) void mark(`del:${serverName}`, () => api.deleteMcpLibrary(serverName))
      })
  }

  return (
    <div className="space-y-4">
      {/* 矩阵小工具栏:左 = 库操作,右 = 添加服务器(进库) */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>
          {L('MCP 库', 'MCP library')} · {libRows.length}
        </span>
        <button className="btn btn-ghost btn-sm" onClick={() => void loadAll()}>
          <RefreshIcon /> {L('刷新', 'Refresh')}
        </button>
        <div className="flex-1" />
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
          {L('改动下次启动实例生效', 'Changes apply on next instance start')}
        </span>
        <button className="btn btn-primary btn-sm" onClick={openNew}>
          <PlusIcon /> {L('添加服务器', 'Add server')}
        </button>
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px]" style={{ color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 12%, transparent)' }}>
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th className="px-3 py-2 font-medium" style={{ color: 'var(--muted)', minWidth: 200 }}>
                {L('服务器', 'Server')}
              </th>
              <th className="px-3 py-2 font-medium" style={{ color: 'var(--muted)' }}>
                {L('传输', 'Transport')}
              </th>
              <th className="px-3 py-2 font-medium" style={{ color: 'var(--muted)' }}>
                {L('地址 / 命令', 'URL / Command')}
              </th>
              {visible.map((i) => {
                const st = states[i.id]?.status
                const running = st === 'running' || st === 'external'
                const loaderMissing = loader[i.id] === false && (perInst[i.id] ?? []).length > 0
                return (
                  <th key={i.id} className="px-2 py-2 font-medium text-center whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                    <span className={`badge-dot mr-1.5 inline-block align-middle${running ? '' : ' opacity-30'}`} style={{ background: running ? 'var(--ok)' : 'var(--muted)' }} />
                    <span className="align-middle">{i.name}</span>
                    {loaderMissing && (
                      <span
                        className="ml-1 align-middle"
                        style={{ color: 'var(--warn)' }}
                        title={L('该实例已分配 MCP 服务器,但缺 @deepseek-ai/dsh-mcp-client 加载器', 'This instance has assigned MCP servers but is missing the @deepseek-ai/dsh-mcp-client loader')}
                      >
                        ⚠
                      </span>
                    )}
                  </th>
                )
              })}
              <th className="px-3 py-2 font-medium text-right" style={{ color: 'var(--muted)' }}>
                {L('操作', 'Actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {libRows.map((row) => (
              <tr key={row.serverName} style={{ borderBottom: '1px solid var(--border)' }}>
                <td className="px-3 py-1.5">
                  <div className="text-[13px] font-semibold leading-tight" style={{ color: 'var(--text)' }}>
                    {row.serverName}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <span className="badge !px-1.5 text-[10px]" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                    {row.transport}
                  </span>
                </td>
                <td className="px-3 py-1.5 max-w-[220px]">
                  <div className="truncate mono" style={{ color: 'var(--muted)' }}>
                    {row.transport === 'stdio' ? row.command : row.url}
                  </div>
                </td>
                {visible.map((inst) => {
                  const c = cell(row.serverName, inst.id)
                  const b = busy.has(`cell:${row.serverName}:${inst.id}`)
                  return (
                    <td key={inst.id} className="px-2 py-1.5 text-center">
                      <button
                        className="badge cursor-pointer select-none whitespace-nowrap"
                        style={cellStyle(c)}
                        disabled={b}
                        title={
                          b
                            ? '…'
                            : c === 'enabled'
                              ? L('点击停用', 'Click to disable')
                              : c === 'disabled'
                                ? L('点击启用', 'Click to enable')
                                : L('把库配置分配到该实例(启用)', 'Assign the library config to this instance (enabled)')
                        }
                        onClick={() => toggleCell(row.serverName, inst.id, c)}
                      >
                        {c === 'enabled' && <span className="badge-dot mr-1" style={{ background: 'var(--ok)' }} />}
                        {b ? '…' : cellLabel(c, L)}
                      </button>
                    </td>
                  )
                })}
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  <button className="btn btn-ghost btn-sm !p-1" title={L('编辑(改库并同步已分配实例)', 'Edit (saves to library and syncs assigned instances)')} onClick={() => openEdit(row)}>
                    {L('编辑', 'Edit')}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm !p-1"
                    title={L('删除(连带所有实例)', 'Delete (incl. every instance)')}
                    onClick={() => deleteRow(row.serverName)}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
            {libRows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center" style={{ color: 'var(--muted)' }} colSpan={visible.length + 4}>
                  {L('MCP 库还没有服务器。点「添加服务器」存入库,再点击实例格分配;或在右侧「MCP 一键使用」选择预置。', 'No MCP servers in the library yet. Click "Add server" to store one, then click an instance cell to assign; or pick a preset on the right.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {missingLoaderCols.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[12px]"
          style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 12%, transparent)' }}
        >
          <span className="flex-1 min-w-[220px]">
            {L(
              '以下实例已分配 MCP 服务器,但缺 @deepseek-ai/dsh-mcp-client 加载器:服务器在下一次启动不会生效(启动可能失败)。',
              'The instances below have assigned MCP servers but are missing the @deepseek-ai/dsh-mcp-client loader — those servers will not load on next start (and boot may fail).'
            )}
          </span>
          {missingLoaderCols.map((inst) => (
            <button
              key={inst.id}
              className="btn btn-sm btn-primary"
              disabled={busy.has(`loader:${inst.id}`)}
              onClick={() => installLoaderFor(inst.id)}
            >
              {busy.has(`loader:${inst.id}`) ? '…' : L(`给「${inst.name}」装加载器`, `Install loader for "${inst.name}"`)}
            </button>
          ))}
        </div>
      )}

      {formOpen && (
        <McpFormModal
          form={form}
          editing={editing}
          onForm={setForm}
          onCancel={closeForm}
          onSave={save}
        />
      )}
    </div>
  )
}

/** MCP 服务器新建 / 编辑 —— 居中 Modal,存/改的是 MCP 库(serverName 唯一)。 */
function McpFormModal({
  form,
  editing,
  onForm,
  onCancel,
  onSave
}: {
  form: FormState
  editing: { originalName?: string } | null
  onForm: (f: FormState) => void
  onCancel: () => void
  onSave: () => void
}): JSX.Element {
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const backdrop = useBackdropClose(onCancel)
  const isEdit = !!editing?.originalName
  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }} onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick}>
      <div className="card p-4 w-full max-w-[560px] space-y-2" onMouseDown={backdrop.contentMouseDown} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-semibold">{isEdit ? L('编辑服务器', 'Edit server') : L('添加服务器', 'Add server')}</h3>
          {!isEdit && (
            <span className="text-[11px]" style={{ color: 'var(--warn)' }}>
              {L('预置服务器需补全密钥后保存', 'Preset servers: fill in secrets before saving')}
            </span>
          )}
          <button className="btn btn-ghost btn-sm ml-auto" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input className="input !py-1 text-[12px]" placeholder={L('服务器名(mcp__名__*)', 'server name (mcp__name__*)')} value={form.serverName} onChange={(e) => onForm({ ...form, serverName: e.target.value })} />
          <select className="input !w-auto !py-1 text-[12px]" value={form.transport} onChange={(e) => onForm({ ...form, transport: e.target.value as McpTransport })}>
            <option value="stdio">stdio</option>
            <option value="streamable-http">streamable-http</option>
          </select>
        </div>

        {form.transport === 'stdio' ? (
          <>
            <div className="flex gap-2">
              <input className="input !py-1 text-[12px] flex-1" placeholder={L('启动命令,如 npx', 'command, e.g. npx')} value={form.command} onChange={(e) => onForm({ ...form, command: e.target.value })} />
              <input className="input !py-1 text-[12px] flex-1" placeholder={L('工作目录(可空)', 'cwd (optional)')} value={form.cwd} onChange={(e) => onForm({ ...form, cwd: e.target.value })} />
            </div>
            <textarea className="input mono text-[11px] h-16 w-full" placeholder={L('参数,每行一个', 'args, one per line')} value={form.args} onChange={(e) => onForm({ ...form, args: e.target.value })} />
            <textarea className="input mono text-[11px] h-20 w-full" placeholder={L('环境变量 KEY=VALUE,每行一个(如 GITHUB_PERSONAL_ACCESS_TOKEN=)', 'env KEY=VALUE, one per line (e.g. GITHUB_PERSONAL_ACCESS_TOKEN=)')} value={form.env} onChange={(e) => onForm({ ...form, env: e.target.value })} />
          </>
        ) : (
          <>
            <input className="input !py-1 text-[12px] w-full" placeholder={L('https://…/mcp', 'https://…/mcp')} value={form.url} onChange={(e) => onForm({ ...form, url: e.target.value })} />
            <textarea className="input mono text-[11px] h-16 w-full" placeholder={L('请求头 KEY=VALUE,每行一个', 'headers KEY=VALUE, one per line')} value={form.headers} onChange={(e) => onForm({ ...form, headers: e.target.value })} />
          </>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            {L('取消', 'Cancel')}
          </button>
          <button className="btn btn-primary btn-sm" disabled={!form.serverName.trim()} onClick={onSave}>
            {L('保存', 'Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
