import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent as ReactDragEvent, JSX } from 'react'
import { api, type DshInstance, type SkillInfo, type SkillMarketRepo, type SkillRepoCandidate } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { useI18n } from '../i18n'
import { RefreshIcon, PlusIcon, TrashIcon } from '../lib/icons'

type CellState = 'enabled' | 'disabled' | 'absent'

// 技能市场条目自适应网格(热门源 / 搜索结果 / 仓库内候选):抽屉窄 1 列、中等 2 列、
// 全展开(内容区 ~900–1100px)恰好 3 列;随容器宽度自动增减列。
const CARD_GRID: CSSProperties = {
  display: 'grid',
  gap: 10,
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))'
}

function useVisibleInstances(): DshInstance[] {
  const { config } = useHarness()
  return useMemo<DshInstance[]>(() => (config?.instances ?? []).filter((i) => i.enabled !== false), [config])
}

function useL(): { L: (zh: string, en: string) => string } {
  const { lang } = useI18n()
  return { L: (zh: string, en: string): string => (lang === 'en' ? en : zh) }
}

const cellStyle = (c: CellState): CSSProperties =>
  c === 'enabled'
    ? { color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }
    : c === 'disabled'
      ? { color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 14%, transparent)' }
      : { color: 'var(--muted)', background: 'var(--bg-soft)' }

/** A library skill row: row model is a SkillInfo from the skill library. */
type RowModel = SkillInfo

/**
 * 技能矩阵主面板(统一扩展页技能类目):行 = 技能库(`skill-library`),列 = 实例;
 * 单元格 = 该实例是否已分配该技能副本(enabled/disabled/absent)。
 * 新建 / 导入 / 市场安装都先进库,点空单元格 = 从库分配到该实例(启用)。
 */
export function SkillMatrixSection(): JSX.Element {
  const { states } = useHarness()
  const visible = useVisibleInstances()
  const { L } = useL()
  const visibleKey = visible.map((i) => i.id).join(',')

  const [libRows, setLibRows] = useState<SkillInfo[]>([])
  const [perInst, setPerInst] = useState<Record<string, { enabled: SkillInfo[]; disabled: SkillInfo[] }>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createBody, setCreateBody] = useState('')

  const loadAll = useCallback(async () => {
    const out: Record<string, { enabled: SkillInfo[]; disabled: SkillInfo[] }> = {}
    let rows: SkillInfo[] = []
    try {
      rows = await api.listSkillLibrary()
    } catch {
      rows = []
    }
    await Promise.all(
      visible.map(async (inst) => {
        try {
          out[inst.id] = await api.listSkills(inst.id)
        } catch {
          out[inst.id] = { enabled: [], disabled: [] }
        }
      })
    )
    setLibRows(rows)
    setPerInst(out)
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

  const cells = useMemo(() => {
    const map: Record<string, Record<string, CellState>> = {}
    for (const row of libRows) {
      map[row.name] = {}
      for (const inst of visible) {
        const st = perInst[inst.id]
        map[row.name][inst.id] = st?.enabled.some((s) => s.name === row.name)
          ? 'enabled'
          : st?.disabled.some((s) => s.name === row.name)
            ? 'disabled'
            : 'absent'
      }
    }
    return map
  }, [libRows, perInst, visibleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleCell = (row: RowModel, instId: string, cell: CellState): void => {
    void mark(`cell:${row.name}:${instId}`, async () => {
      if (cell === 'enabled') await api.setSkillEnabled(instId, row.name, false)
      else await api.enableSkillFromLibrary(instId, row.name) // absent / disabled → copy from the library, enabled
    })
  }

  const toggleModel = (row: RowModel): void => {
    void mark(`pol:${row.name}`, () =>
      api.setSkillLibraryPolicy(row.name, { disableModelInvocation: row.disableModelInvocation ? false : true }))
  }

  const checkUpdates = (): void => {
    void mark('check-updates', async () => {
      const updates = await api.checkSkillUpdates()
      if (updates.length === 0) setError(L('已是最新', 'All skills are up to date'))
      else {
        for (const u of updates) await api.updateSkill(u.name)
      }
    })
  }

  const createSkill = (): void => {
    const name = createName.trim()
    if (!name) return
    void mark(`create:${name}`, async () => {
      await api.createSkill(name, createDesc.trim(), createBody)
      setCreateOpen(false)
      setCreateName('')
      setCreateDesc('')
      setCreateBody('')
    })
  }

  // 新建弹窗里拖放导入成功后的刷新信号(父级关闭弹窗并重载矩阵)。
  const handleImported = (): void => {
    setCreateOpen(false)
    setCreateName('')
    setCreateDesc('')
    setCreateBody('')
    void loadAll()
  }

  const rowBusy = (name: string): boolean =>
    busy.has(`pol:${name}`) || busy.has(`up:${name}`) || busy.has(`del:${name}`)

  return (
    <div className="space-y-4">
      {/* 矩阵小工具栏:左 = 库操作,右 = 新建(进库) */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>
          {L('技能库', 'Skill library')} · {libRows.length}
        </span>
        <button className="btn btn-ghost btn-sm" onClick={() => void loadAll()}>
          <RefreshIcon /> {L('刷新', 'Refresh')}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={checkUpdates}>
          {L('检查更新', 'Check updates')}
        </button>
        <div className="flex-1" />
        <button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon /> {L('新建技能', 'New skill')}
        </button>
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px]" style={{ color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 12%, transparent)' }}>
          {error}
        </div>
      )}

      {/* matrix */}
      <div className="overflow-x-auto rounded-xl" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th className="px-3 py-2 font-medium" style={{ color: 'var(--muted)', minWidth: 200 }}>
                {L('技能', 'Skill')}
              </th>
              <th className="px-3 py-2 font-medium" style={{ color: 'var(--muted)' }}>
                {L('允许调用', 'Allow invoke')}
              </th>
              {visible.map((i) => {
                const st = states[i.id]?.status
                const running = st === 'running' || st === 'external'
                return (
                  <th key={i.id} className="px-2 py-2 font-medium text-center whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                    <span className={`badge-dot mr-1.5 inline-block align-middle${running ? '' : ' opacity-30'}`} style={{ background: running ? 'var(--ok)' : 'var(--muted)' }} />
                    <span className="align-middle">{i.name}</span>
                  </th>
                )
              })}
              <th className="px-3 py-2 font-medium text-right" style={{ color: 'var(--muted)' }}>
                {L('操作', 'Actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {libRows.map((row) => {
              const rBusy = rowBusy(row.name)
              return (
                <tr key={row.name} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td className="px-3 py-1.5">
                    <div className="text-[13px] font-semibold leading-tight" style={{ color: 'var(--text)' }}>
                      {row.name}
                    </div>
                    <div className="text-[11px] mt-0.5 truncate leading-tight" style={{ color: 'var(--muted)', maxWidth: 260 }}>
                      {row.description || '—'}
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    <button
                      role="switch"
                      aria-checked={!row.disableModelInvocation}
                      disabled={rBusy}
                      className="relative inline-flex h-[18px] w-[34px] shrink-0 items-center rounded-full border transition-colors disabled:opacity-50"
                      style={{
                        background: row.disableModelInvocation ? 'var(--bg-soft)' : 'var(--ok)',
                        borderColor: 'var(--border)'
                      }}
                      title={
                        row.disableModelInvocation
                          ? L('模型不可自动调用,点击允许', 'model cannot auto-invoke; click to allow')
                          : L('模型可自动调用,点击禁止', 'model may auto-invoke; click to disallow')
                      }
                      onClick={() => toggleModel(row)}
                    >
                      <span
                        className="absolute h-[12px] w-[12px] rounded-full transition-all"
                        style={{ background: '#fff', left: row.disableModelInvocation ? 2 : 20 }}
                      />
                    </button>
                  </td>
                  {visible.map((inst) => {
                    const c = cells[row.name]?.[inst.id] ?? 'absent'
                    const cellBusy = busy.has(`cell:${row.name}:${inst.id}`)
                    return (
                      <td key={inst.id} className="px-2 py-1.5 text-center">
                        <button
                          className="badge cursor-pointer select-none whitespace-nowrap"
                          style={cellStyle(c)}
                          disabled={cellBusy}
                          title={
                            cellBusy
                              ? '…'
                              : c === 'enabled'
                                ? L('点击停用', 'Click to disable')
                                : c === 'disabled'
                                  ? L('点击启用(从库刷新)', 'Click to enable (refresh from library)')
                                  : L('从技能库分配到该实例', 'Assign from the skill library to this instance')
                          }
                          onClick={() => toggleCell(row, inst.id, c)}
                        >
                          {c === 'enabled' && <span className="badge-dot mr-1" style={{ background: 'var(--ok)' }} />}
                          {cellBusy ? '…' : c === 'enabled' ? L('已启用', 'Enabled') : L('未启用', 'Not enabled')}
                        </button>
                      </td>
                    )
                  })}
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {row.origin && (
                      <button
                        className="btn btn-ghost btn-sm !p-1"
                        disabled={rBusy}
                        title={L('从仓库更新', 'Update from repo')}
                        onClick={() => void mark(`up:${row.name}`, () => api.updateSkill(row.name))}
                      >
                        <RefreshIcon />
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-sm !p-1"
                      disabled={rBusy}
                      title={L('删除', 'Delete')}
                      onClick={() =>
                        void api
                          .confirm(L(`删除技能「${row.name}」?将同时从所有实例移除该技能副本。`, `Delete skill "${row.name}"? Its copies are removed from every instance too.`))
                          .then((ok) => {
                            if (ok) void mark(`del:${row.name}`, () => api.deleteSkillLibrary(row.name))
                          })
                      }
                    >
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              )
            })}
            {libRows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center" style={{ color: 'var(--muted)' }} colSpan={visible.length + 3}>
                  {L('技能库还没有技能。用上方「新建 / 导入」或右侧「技能市场」把技能存入库,再点击实例格分配。', 'The skill library is empty. Add skills with New / Import above or the skill market on the right, then click an instance cell to assign.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <SkillCreateModal
          name={createName}
          desc={createDesc}
          body={createBody}
          onName={setCreateName}
          onDesc={setCreateDesc}
          onBody={setCreateBody}
          onCancel={() => setCreateOpen(false)}
          onCreate={createSkill}
          onImported={handleImported}
        />
      )}
    </div>
  )
}

/** 新建技能弹窗:顶部大拖放区(拖入 .md 文件或含 SKILL.md 的文件夹) + 下方手动粘贴创建。都写入技能库。 */
function SkillCreateModal({
  name,
  desc,
  body,
  onName,
  onDesc,
  onBody,
  onCancel,
  onCreate,
  onImported
}: {
  name: string
  desc: string
  body: string
  onName: (v: string) => void
  onDesc: (v: string) => void
  onBody: (v: string) => void
  onCancel: () => void
  onCreate: () => void
  /** 拖放导入成功后回调(父级关闭弹窗并刷新矩阵)。 */
  onImported: () => void
}): JSX.Element {
  const { L } = useL()
  const backdrop = useBackdropClose(onCancel)
  const [dropOver, setDropOver] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [repoBusy, setRepoBusy] = useState(false)
  // dragenter/leave 会按子元素边界触发;用深度计数避免在内容上移动时闪烁高亮。
  const dragDepth = useRef(0)

  // Electron 拖入的文件带 `.path`(文件/文件夹都一样);TS 未声明该字段,故断言。
  const dropPath = (f: File): string | undefined => (f as File & { path?: string }).path

  const runImport = async (path: string): Promise<void> => {
    setImporting(true)
    setImportErr(null)
    try {
      await api.importSkillPath(path)
      onImported()
    } catch (err) {
      setImporting(false)
      setImportErr(err instanceof Error ? err.message : String(err))
    }
  }

  /** 从仓库 URL 安装(替代原来市场底部的直装行),进技能库。 */
  const installFromUrl = async (): Promise<void> => {
    const url = repoUrl.trim()
    if (!url || repoBusy) return
    setRepoBusy(true)
    setImportErr(null)
    try {
      await api.installSkillRepo(url)
      onImported()
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : String(err))
      setRepoBusy(false)
    }
  }

  const handleDrop = async (e: ReactDragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setDropOver(false)
    const files = Array.from(e.dataTransfer.files)
    const file = files[0]
    if (!file) {
      setImportErr(L('未读取到拖入的文件', 'No file was dropped'))
      return
    }
    const path = dropPath(file)
    if (!path) {
      setImportErr(L('无法读取拖入路径(拖放仅桌面版可用)', 'Cannot read the dropped path (drag & drop is desktop-only)'))
      return
    }
    await runImport(path)
  }

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }} onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick}>
      <div className="card p-4 w-full max-w-[540px] space-y-2" onMouseDown={backdrop.contentMouseDown} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[15px] font-semibold">{L('新建技能', 'New skill')}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>✕</button>
        </div>

        {/* 大拖放区:整个块可 drop,拖入即写入技能库 */}
        <div
          className="flex flex-col items-center justify-center rounded-xl-2 border-dashed px-3 py-5 text-center transition-colors"
          style={{
            borderColor: dropOver ? 'var(--accent)' : 'var(--border)',
            background: dropOver ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-soft)'
          }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropOver(true) }}
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); dragDepth.current += 1; setDropOver(true) }}
          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDropOver(false) } }}
          onDrop={(e) => void handleDrop(e)}
        >
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
            {importing ? L('导入中…', 'Importing…') : L('拖入 SKILL.md 文件或整个技能文件夹', 'Drop a SKILL.md file or a whole skill folder')}
          </div>
          <div className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>
            {L('文件/文件夹放到此处即存入技能库(文件夹内的 .git 会被跳过)', 'Drop a file or folder here to store it in the skill library (.git is skipped)')}
          </div>
        </div>

        {importErr && (
          <div className="rounded-lg px-3 py-2 text-[12px]" style={{ color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 12%, transparent)' }}>
            {importErr}
          </div>
        )}

        <div className="flex items-center gap-2 py-0.5">
          <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {L('或从仓库 URL 安装', 'or install from a repo URL')}
          </span>
          <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
        </div>

        <div className="flex gap-2">
          <input
            className="input !py-1 text-[12px] flex-1"
            placeholder={L('github.com/user/repo#/可选子路径', 'github.com/user/repo#/optional/path')}
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void installFromUrl() }}
          />
          <button className="btn btn-primary btn-sm" disabled={!repoUrl.trim() || repoBusy} onClick={() => void installFromUrl()}>
            {repoBusy ? '…' : L('安装', 'Install')}
          </button>
        </div>

        <div className="flex items-center gap-2 py-0.5">
          <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {L('或手动粘贴', 'or paste manually')}
          </span>
          <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
        </div>

        <div className="flex gap-2">
          <input className="input !py-1 text-[12px]" placeholder={L('名称(小写 kebab,如 my-skill)', 'name (lowercase kebab, e.g. my-skill)')} value={name} onChange={(e) => onName(e.target.value)} />
          <input className="input !py-1 text-[12px] flex-1" placeholder={L('描述', 'description')} value={desc} onChange={(e) => onDesc(e.target.value)} />
        </div>
        <textarea className="input mono text-[11px] h-32 w-full" placeholder={L('SKILL.md 正文(可含完整 frontmatter)…', 'SKILL.md body (may include full frontmatter)…')} value={body} onChange={(e) => onBody(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>{L('取消', 'Cancel')}</button>
          <button className="btn btn-primary btn-sm" disabled={!name.trim() || importing} onClick={onCreate}>{L('创建', 'Create')}</button>
        </div>
      </div>
    </div>
  )
}

/** 技能市场源:第一个 = GitHub(搜索+分类,仿插件市场);后两个 = 官方/社区技能仓库。 */
interface SkillMarketSource {
  id: string
  fullName: string
  kind: 'search' | 'repo'
  owner?: string
  repo?: string
  descZh: string
  descEn: string
}

const SKILL_MARKET_SOURCES: SkillMarketSource[] = [
  { id: 'anthropics', fullName: 'anthropics/skills', kind: 'repo', owner: 'anthropics', repo: 'skills', descZh: 'Anthropic 官方 Claude Skills', descEn: "Anthropic's official Claude Skills" },
  { id: 'obra', fullName: 'obra/superpowers', kind: 'repo', owner: 'obra', repo: 'superpowers', descZh: 'Obra Superpowers(SKILL 集合)', descEn: 'Obra Superpowers (SKILL collection)' },
  { id: 'github', fullName: 'GitHub', kind: 'search', descZh: '按 GitHub topic 搜索技能仓库', descEn: 'search skill repos by GitHub topic' }
]

/** 技能 GitHub 搜索的分类 chips(每个映射一个 topic 词,与关键词 AND)。 */
const SKILL_CATEGORIES: { id: string; zh: string; en: string; topic: string | undefined }[] = [
  { id: 'all', zh: '全部', en: 'All', topic: undefined },
  { id: 'dsh-skill', zh: 'DSH', en: 'DSH', topic: 'dsh-skill' },
  { id: 'claude-skills', zh: 'Claude', en: 'Claude', topic: 'claude-skills' },
  { id: 'agent-skills', zh: 'Agent', en: 'Agent', topic: 'agent-skills' }
]

/** 技能市场抽屉内容:源 = GitHub 搜索(带搜索栏+分类栏,仿插件市场)/ anthropics / obra。
 *  GitHub 源搜到的是「技能仓库」卡片,点进仓库后是其 SKILL.md 候选(技能卡片);
 *  仓库源直接列 SKILL.md。所有安装进技能库。 */
export function SkillMarketPanel({ onChanged }: { onChanged: () => void }): JSX.Element {
  const { lang } = useI18n()
  const { L } = useL()
  const [sourceId, setSourceId] = useState<string>(SKILL_MARKET_SOURCES[0].id)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('all')
  const [repos, setRepos] = useState<SkillMarketRepo[] | null>(null)
  const [viewing, setViewing] = useState<SkillMarketRepo | null>(null)
  const [cands, setCands] = useState<SkillRepoCandidate[]>([])
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const seqRef = useRef(0)

  const source = SKILL_MARKET_SOURCES.find((s) => s.id === sourceId) ?? SKILL_MARKET_SOURCES[0]

  const mark = (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy((prev) => new Set(prev).add(key))
    setError(null)
    return fn()
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setBusy((prev) => {
        const n = new Set(prev)
        n.delete(key)
        return n
      }))
  }

  const refreshLibrary = async (): Promise<void> => {
    try {
      const lib = await api.listSkillLibrary()
      setInstalledNames(new Set(lib.map((s) => s.name)))
    } catch {
      /* 非致命 */
    }
  }

  // 仓库源的技能候选 / GitHub 源点进仓库后的候选共用加载。
  const loadCands = async (owner: string, repo: string, label: string): Promise<void> => {
    setCands([])
    setError(null)
    setLoading(true)
    const seq = ++seqRef.current
    try {
      const list = await api.listSkillRepoSkills(owner, repo)
      if (seq === seqRef.current) setCands(list)
    } catch (e) {
      if (seq === seqRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
    void label
  }

  const selectSource = (id: string): void => {
    setSourceId(id)
    setViewing(null)
    setRepos(null)
    setQuery('')
    setCategory('all')
    setError(null)
    const s = SKILL_MARKET_SOURCES.find((x) => x.id === id)
    if (s && s.kind === 'repo' && s.owner && s.repo) void loadCands(s.owner, s.repo, s.fullName)
  }

  useEffect(() => {
    void refreshLibrary()
    // 初始即加载第一个仓库源(anthropics),打开面板就有技能卡片可看。
    const s = SKILL_MARKET_SOURCES.find((x) => x.kind === 'repo')
    if (s && s.owner && s.repo) void loadCands(s.owner, s.repo, s.fullName)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const searchGithub = async (): Promise<void> => {
    if (source.kind !== 'search') return
    const topic = SKILL_CATEGORIES.find((c) => c.id === category)?.topic
    setLoading(true)
    setError(null)
    setViewing(null)
    const seq = ++seqRef.current
    try {
      const r = await api.searchSkillMarket(query.trim() || undefined, topic)
      if (seq === seqRef.current) setRepos(r)
    } catch (e) {
      if (seq === seqRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }

  const openRepo = (repo: SkillMarketRepo): void => {
    setViewing(repo)
    void loadCands(repo.owner, repo.repo, repo.fullName)
  }

  const repoBase = (): { owner: string; repo: string; label: string } | null => {
    if (viewing) return { owner: viewing.owner, repo: viewing.repo, label: viewing.fullName }
    if (source.owner && source.repo) return { owner: source.owner, repo: source.repo, label: source.fullName }
    return null
  }

  const installSkill = (cand: SkillRepoCandidate): void => {
    const base = repoBase()
    if (!base) return
    const url = `https://github.com/${base.owner}/${base.repo}${cand.path ? `#${cand.path}` : ''}`
    void mark(`market:${cand.path}`, async () => {
      await api.installSkillRepo(url)
      await refreshLibrary()
      onChanged()
    })
  }

  const renderSkillCards = (label: string): JSX.Element => {
    if (loading) {
      return (
        <div className="py-10 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
          {L('加载中…', 'Loading…')}
        </div>
      )
    }
    if (cands.length === 0) {
      return (
        <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
          {L('没有找到 SKILL.md(深层目录不会列出)', 'No SKILL.md found (deep paths are not listed)')}
        </div>
      )
    }
    return (
      <div style={CARD_GRID}>
        {cands.map((c) => {
          const installed = !!c.name && installedNames.has(c.name)
          const bKey = `market:${c.path}`
          const initial = (repoBase()?.owner ?? '?').slice(0, 1).toUpperCase()
          return (
            <div
              key={c.path}
              className="card flex cursor-pointer flex-col gap-2 p-3.5 transition-colors"
              style={{ borderColor: 'var(--border)' }}
              onClick={() => { if (!installed && !busy.has(bKey)) installSkill(c) }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold uppercase"
                  style={{ background: 'var(--bg-soft)', color: 'var(--accent)' }}
                >
                  {initial}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mono truncate text-[13px] font-semibold">{c.name ?? c.path}</div>
                  <div className="mono truncate text-[10.5px]" style={{ color: 'var(--muted)' }}>
                    {c.path}
                  </div>
                </div>
                {installed && (
                  <span className="badge shrink-0" style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }}>
                    {L('已入库存', 'In library')}
                  </span>
                )}
              </div>
              <p className="line-clamp-2 flex-1 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                {c.description ?? '—'}
              </p>
              <div className="flex items-center justify-between">
                <span className="truncate text-[11px]" style={{ color: 'var(--muted)' }}>
                  {label}
                </span>
                <button
                  className="btn btn-sm btn-primary !px-2 !py-0.5"
                  disabled={installed || busy.has(bKey)}
                  onClick={(e) => { e.stopPropagation(); if (!installed) installSkill(c) }}
                >
                  {busy.has(bKey) ? '…' : installed ? L('已装', 'Installed') : L('安装', 'Install')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* 源切换(仿插件市场工具栏:右下拉;GitHub 源额外提供搜索栏 + 分类 chips) */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-[12px] font-medium" style={{ color: 'var(--muted)' }}>
          {L('技能源', 'Source')}
        </span>
        <select
          className="input h-auto min-w-[120px] max-w-[180px] shrink-0 text-[12px]"
          value={sourceId}
          onChange={(e) => selectSource(e.target.value)}
        >
          {SKILL_MARKET_SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.fullName}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--muted)' }}>
          {lang === 'zh' ? source.descZh : source.descEn}
        </span>
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px]" style={{ color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 12%, transparent)' }}>
          {error}
        </div>
      )}

      {source.kind === 'search' && !viewing ? (
        <>
          {/* 搜索栏(仿插件市场) */}
          <div className="flex items-center gap-2">
            <input
              className="input !py-1 text-[12px] flex-1"
              placeholder={L('搜索技能仓库…', 'Search skill repos…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void searchGithub() }}
            />
            <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void searchGithub()}>
              {L('搜索', 'Search')}
            </button>
          </div>
          {/* 分类栏(仿插件市场 chips,映射 topic) */}
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {SKILL_CATEGORIES.map((c) => {
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
                  onClick={() => { setCategory(c.id); void searchGithub() }}
                >
                  {lang === 'zh' ? c.zh : c.en}
                </button>
              )
            })}
          </div>
          {/* 搜索结果 = 技能仓库卡片(插件市场同款) */}
          {loading ? (
            <div className="py-10 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
              {L('搜索中…', 'Searching…')}
            </div>
          ) : repos && repos.length === 0 ? (
            <div className="card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
              {L('无结果', 'No results')}
            </div>
          ) : repos ? (
            <div style={CARD_GRID}>
              {repos.map((r) => (
                <div
                  key={r.fullName}
                  className="card flex cursor-pointer flex-col gap-2 p-3.5 transition-colors"
                  style={{ borderColor: 'var(--border)' }}
                  onClick={() => openRepo(r)}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold uppercase"
                      style={{ background: 'var(--bg-soft)', color: 'var(--accent)' }}
                    >
                      {r.owner.slice(0, 1)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="mono truncate text-[13px] font-semibold">{r.fullName}</div>
                      <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                        ⭐ {r.stars}
                      </div>
                    </div>
                  </div>
                  <p className="line-clamp-2 flex-1 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                    {r.description || '—'}
                  </p>
                  <div className="text-right text-[12px] font-medium" style={{ color: 'var(--accent)' }}>
                    {L('查看技能 →', 'View skills →')}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="card p-4 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
              {L('输入关键词或选分类后搜索。', 'Type a keyword or pick a category to search.')}
            </div>
          )}
        </>
      ) : source.kind === 'search' && viewing ? (
        <>
          <div className="flex items-center gap-2 text-[12px] font-medium">
            {viewing.fullName}
            <button className="btn btn-ghost btn-sm" onClick={() => { setViewing(null); setCands([]) }}>
              {L('← 返回', '← back')}
            </button>
          </div>
          {renderSkillCards(viewing.fullName)}
        </>
      ) : (
        renderSkillCards(source.fullName)
      )}

      <p className="text-[11px] leading-snug" style={{ color: 'var(--muted)' }}>
        {L('安装会存入技能库;随后在主矩阵点对应实例格即可分配到该实例。', 'Installing stores the skill in the skill library; assign it to instances from the matrix afterwards.')}
      </p>
    </div>
  )
}
