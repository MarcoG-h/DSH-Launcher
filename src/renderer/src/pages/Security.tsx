import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api, type ProbeStatus, type SecurityAuditEvent, type SecurityConfig } from '../lib/api'
import { useI18n } from '../i18n'
import { Toggle } from '../components/Toggle'
import { ShieldIcon } from '../lib/icons'
import { useBackdropClose } from '../hooks/useBackdropClose'

type TabId = 'timeline' | 'sensitive' | 'settings'

function fmtTime(t: number): string {
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 事件类别、风险分级、官方工具排除表等共享逻辑(与侧边栏告警弹窗共用)。 */
import {
  OFFICIAL_TOOLS,
  RISK_LEVELS,
  type EventCat,
  CAT_COLOR,
  CAT_LABEL_KEY,
  categoryOf,
  riskColor
} from '../lib/securityRisk'

const TYPE_ZH: Record<string, string> = {
  'user/message': '用户消息',
  'assistant/message': '助手消息',
  'assistant/chunk': '流式块',
  'tool/call': '工具调用',
  'tool/result': '工具结果',
  'turn/start': '回合开始',
  'turn/end': '回合结束',
  'step/start': '步骤开始',
  'step/end': '步骤结束'
}

/** 横向时间轴:一条轴从左(旧)到右(新),事件为卡片,点卡片弹出详情弹窗。 */
function HorizontalTimeline({ events, onOpen, riskOf, catOf, t }: {
  events: SecurityAuditEvent[]
  onOpen: (e: SecurityAuditEvent) => void
  riskOf: (e: SecurityAuditEvent) => boolean
  catOf: (e: SecurityAuditEvent, isRisk: (x: SecurityAuditEvent) => boolean) => EventCat
  t: (k: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  // 卡片等距横排(时间从左→右推进)。列与列间的最小间距,卡片固定宽。
  const CARD_W = 150
  const GAP = 22
  const AXIS_Y = 7 // 轴心线的垂直位置(圆点圆心)
  const sorted = useMemo(() => [...events].sort((a, b) => (a.t ?? 0) - (b.t ?? 0)), [events])
  // 跟随最新:进入页面/数据刷新时若停留在最新位置(最右端)则自动滚到最新;
  // 用户手动往左翻看历史时尊重,不打断。
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const nearLatest = (): boolean => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollWidth - el.scrollLeft - el.clientWidth < 48
  }
  const scrollToLatest = (): void => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }
  useEffect(() => {
    if (stickRef.current) scrollToLatest()
  }, [sorted])

  return (
    <div ref={scrollRef} className="overflow-x-auto" style={{ maxHeight: '60vh' }} onScroll={() => { stickRef.current = nearLatest() }}>
      <div className="relative inline-block" style={{ paddingTop: AXIS_Y, minWidth: sorted.length * (CARD_W + GAP) }}>
        {/* 轴心线 */}
        <div
          className="absolute left-0 right-0"
          style={{ top: AXIS_Y, height: 2, background: 'color-mix(in srgb, var(--border) 55%, transparent)' }}
        />
        <div className="flex items-start">
          {sorted.map((e, i) => {
            const cred = riskOf(e)
            const cat = catOf(e, riskOf)
            // 节点/徽标颜色:风险类用黄/橙/红(按等级),消息/工具用类别色。
            const nodeColor = cred ? riskColor(e) : CAT_COLOR[cat]
            const rcol = cred ? riskColor(e) : undefined
            const high = cred && e.sev === 2
            return (
              <div key={i} className="flex-shrink-0" style={{ marginLeft: i === 0 ? 8 : GAP }}>
                <div className="flex flex-col items-center" style={{ width: CARD_W }}>
                  {/* 轴上的圆点:类别色/风险色 */}
                  <div
                    className="rounded-full border-2 shrink-0"
                    style={{
                      width: 11,
                      height: 11,
                      borderColor: nodeColor,
                      background: nodeColor,
                      transform: 'translateY(-50%)'
                    }}
                  />
                  {/* 卡片:操作者 + 事件(点开弹详情弹窗),按风险等级着色 */}
                  <button
                    className="w-full mt-2 rounded-[10px] border p-2 text-left cursor-pointer transition-all hover:-translate-y-0.5"
                    style={{
                      borderColor: high ? rcol : cred ? 'color-mix(in srgb, ' + rcol + ' 55%, transparent)' : 'var(--border)',
                      background: high
                        ? 'color-mix(in srgb, ' + rcol + ' 14%, transparent)'
                        : 'color-mix(in srgb, var(--border) 8%, transparent)',
                      boxShadow: high ? '0 0 0 2px color-mix(in srgb, ' + rcol + ' 30%, transparent)' : 'none'
                    }}
                    onClick={() => onOpen(e)}
                  >
                    {/* 类别徽标:风险类显示具体黄/橙/红 */}
                    <div className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: nodeColor }} />
                      <span className="text-[9.5px] uppercase tracking-wide shrink-0" style={{ color: nodeColor }}>{t(CAT_LABEL_KEY[cat])}</span>
                    </div>
                    {/* 操作者(实例名只在详情弹窗显示) */}
                    <div className="text-[12.5px] font-semibold truncate mt-0.5">{e.actor ?? '—'}</div>
                    {/* 事件类型 */}
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-[11.5px] truncate" style={{ color: rcol ?? 'var(--text)' }}>{TYPE_ZH[e.type] ?? e.type}</span>
                      {high
                        ? <span className="shrink-0 text-[10px] font-bold px-1 rounded" style={{ color: rcol, background: 'color-mix(in srgb, ' + rcol + ' 20%, transparent)' }}>{t('security.highRisk')}</span>
                        : cred && <span className="shrink-0 text-[10px] font-semibold" style={{ color: rcol }}>{t('security.credFlag')}</span>}
                    </div>
                    {/* 时间角标 */}
                    <div className="mono text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>{fmtTime(e.t)}</div>
                    {/* 风险:脱敏密钥预览(黄/橙/红同色) */}
                    {cred && e.key && rcol && (
                      <div className="mono text-[10.5px] mt-1 truncate rounded px-1 py-0.5" style={{ color: rcol, background: 'color-mix(in srgb, ' + rcol + ' 14%, transparent)' }}>{e.key}</div>
                    )}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** 竖向列表时间轴:每行 类别 · 操作者 · 事件 · 时间,点开弹详情弹窗。 */
function VerticalTimeline({ events, onOpen, riskOf, catOf, t }: {
  events: SecurityAuditEvent[]
  onOpen: (e: SecurityAuditEvent) => void
  riskOf: (e: SecurityAuditEvent) => boolean
  catOf: (e: SecurityAuditEvent, isRisk: (x: SecurityAuditEvent) => boolean) => EventCat
  t: (k: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const sorted = useMemo(() => [...events].sort((a, b) => (b.t ?? 0) - (a.t ?? 0)), [events])
  // 跟随最新:进入页面/数据刷新时若停留在最新位置(底部)则自动滚到最新;
  // 用户手动往上翻看历史时尊重,不打断。
  const listRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const nearLatest = (): boolean => {
    const el = listRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }
  const scrollToLatest = (): void => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  useEffect(() => {
    if (stickRef.current) scrollToLatest()
  }, [sorted])
  return (
    <div ref={listRef} className="relative max-h-[56vh] overflow-y-auto space-y-1.5 pr-1" onScroll={() => { stickRef.current = nearLatest() }}>
      {/* 竖向引导轴 */}
      <div
        className="absolute left-[11px] top-2 bottom-2 w-[2px] rounded-full"
        style={{ background: 'color-mix(in srgb, var(--border) 55%, transparent)' }}
      />
      {sorted.map((e, i) => {
        const cat = catOf(e, riskOf)
        const rcol = riskOf(e) ? riskColor(e) : undefined
        // 节点颜色:风险类用黄/橙/红三色(按风险等级),消息/工具用类别色。
        const nodeColor = rcol ?? CAT_COLOR[cat]
        return (
          <div key={i} className="relative flex items-center gap-2">
            {/* 轴上的节点 */}
            <div className="w-[24px] shrink-0 flex justify-center">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: nodeColor, boxShadow: '0 0 0 3px color-mix(in srgb, ' + nodeColor + ' 22%, transparent)' }}
              />
            </div>
            <button
              className="flex-1 min-w-0 flex items-center gap-2.5 text-[12.5px] rounded px-2.5 py-2 text-left cursor-pointer transition-colors hover:opacity-85"
              style={{ background: 'color-mix(in srgb, var(--border) 10%, transparent)' }}
              onClick={() => onOpen(e)}
            >
              {/* 类别徽标(风险类显示具体黄/橙/红) */}
              <span className="w-[52px] shrink-0 text-[10.5px] font-medium" style={{ color: nodeColor }}>{t(CAT_LABEL_KEY[cat])}</span>
              {/* 操作者(实例名只在详情弹窗显示) */}
              <span className="truncate font-semibold shrink-0 w-[96px]" style={{ color: 'var(--text)' }}>{e.actor ?? '—'}</span>
              {/* 事件类型 */}
              <span className="flex-1 min-w-0 truncate" style={{ color: rcol ?? 'var(--text)' }}>{TYPE_ZH[e.type] ?? e.type}</span>
              {/* 风险/密钥 */}
              {rcol && e.key && (
                <span className="mono text-[11px] shrink-0 rounded px-1 py-0.5" style={{ color: rcol, background: 'color-mix(in srgb, ' + rcol + ' 16%, transparent)' }}>{e.key}</span>
              )}
              {/* 时间 */}
              <span className="mono text-[11px] shrink-0" style={{ color: 'var(--muted)' }}>{fmtTime(e.t)}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** 事件详情弹窗:展示类型/时间/操作者/风险/脱敏原文。 */
function EventDetailModal({ event, onClose, riskOf, t }: {
  event: SecurityAuditEvent | null
  onClose: () => void
  riskOf: (e: SecurityAuditEvent) => boolean
  t: (k: string, vars?: Record<string, string | number>) => string
}): JSX.Element | null {
  if (!event) return null
  const cred = riskOf(event)
  const high = cred && event.sev === 2
  const backdrop = useBackdropClose(onClose)
  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={backdrop.onMouseDown}
      onClick={backdrop.onClick}
    >
      <div
        className="panel flex max-h-[80vh] w-full max-w-[560px] flex-col p-0"
        onMouseDown={backdrop.contentMouseDown}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between gap-3 border-b p-4" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[15px] font-semibold truncate">{TYPE_ZH[event.type] ?? event.type}</span>
            {high && (
              <span className="shrink-0 text-[11px] font-bold px-1.5 py-0.5 rounded" style={{ color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 20%, transparent)' }}>
                {t('security.highRisk')}
              </span>
            )}
          </div>
          <button className="btn btn-ghost btn-sm shrink-0" onClick={onClose}>✕</button>
        </div>
        {/* body */}
        <div className="overflow-y-auto p-4 space-y-3">
          {/* 所属实例 */}
          {event.instanceName && (
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
              {t('security.colInstance')}: <span className="font-medium" style={{ color: 'var(--text)' }}>{event.instanceName}</span>
            </div>
          )}
          {/* 元信息 */}
          <div className="grid grid-cols-2 gap-2 text-[12.5px]">
            <div>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{t('security.colTime')}</div>
              <div className="mono mt-0.5">{fmtTime(event.t)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{t('security.colActor')}</div>
              <div className="mt-0.5">{event.actor ?? '—'}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Session</div>
              <div className="mono mt-0.5">{event.sid.slice(0, 16)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Hash</div>
              <div className="mono mt-0.5">{event.h}</div>
            </div>
          </div>

          {/* 高风险:脱敏密钥 */}
          {high && event.key && (
            <div className="mono text-[13px] rounded px-3 py-2 font-semibold" style={{ color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 14%, transparent)' }}>
              {t('security.highRisk')} · {event.key}
            </div>
          )}

          {/* 原始内容 */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--muted)' }}>{t('security.expandRaw')}</div>
            {event.raw != null && event.raw !== ''
              ? <pre className="mono text-[12px] rounded p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-[46vh] overflow-y-auto"
                  style={{ background: 'color-mix(in srgb, var(--border) 20%, transparent)', color: 'var(--text)' }}>{event.raw}</pre>
              : <div className="text-[12px] px-1" style={{ color: 'var(--muted)' }}>{t('security.noRaw')}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

export function Security(): JSX.Element {
  const { t } = useI18n()
  const [tab, setTab] = useState<TabId>('timeline')
  const [events, setEvents] = useState<SecurityAuditEvent[]>([])
  const [cfg, setCfg] = useState<SecurityConfig | null>(null)
  const [probes, setProbes] = useState<ProbeStatus[]>([])
  const [busyProbe, setBusyProbe] = useState<string | null>(null)
  // 哪个实例的「保护中」被点击,展开重装/停用保护菜单。
  const [probeMenu, setProbeMenu] = useState<string | null>(null)
  const [onlyCred, setOnlyCred] = useState(false)
  const [onlyCat, setOnlyCat] = useState<'all' | EventCat>('all')
  // 实例筛选:null = 全部实例。
  const [filterInstance, setFilterInstance] = useState<string | null>(null)
  // 第三方工具白名单(从白名单文件读取)。
  const [whitelist, setWhitelist] = useState<string[]>([])
  // 事件详情以弹窗展示:当前查看的事件,弹窗关闭时置空。
  const [detail, setDetail] = useState<SecurityAuditEvent | null>(null)
  // 时间轴展示方式:横向轴 / 竖向列表(记忆在 localStorage)。
  const [viewMode, setViewModeState] = useState<'axis' | 'list'>(() => {
    try { return localStorage.getItem('dsh-launcher-timeline-view') === 'list' ? 'list' : 'axis' } catch { return 'axis' }
  })
  const setViewMode = (m: 'axis' | 'list'): void => {
    setViewModeState(m)
    try { localStorage.setItem('dsh-launcher-timeline-view', m) } catch { /* 忽略 */ }
  }

  // 探针开关:默认开启。关闭后不拉取探针数据,时间轴/风险卡片变黑。
  const probeActive = cfg?.probeEnabled !== false
  const load = useCallback(async (): Promise<void> => {
    // 探针关闭时不接收探针数据(清空事件)。
    if (!probeActive) {
      setEvents([])
    } else {
      try {
        setEvents(await api.securityList())
      } catch { /* 非致命 */ }
    }
    try {
      setProbes(await api.securityListProbeStatus())
    } catch { /* 非致命 */ }
    try {
      setWhitelist(await api.securityGetWhitelist())
    } catch { /* 非致命 */ }
  }, [probeActive])
  useEffect(() => {
    void load()
    void api.securityGetConfig().then(setCfg).catch(() => undefined)
    const id = setInterval(() => void load(), 3000)
    return () => clearInterval(id)
  }, [load])

  const setCfgField = async (k: keyof SecurityConfig, v: boolean): Promise<void> => {
    setCfg(await api.securitySetConfig({ [k]: v }))
  }
  // 真实删除审计历史 + 打开白名单文件。
  const clearAudit = async (): Promise<void> => {
    await api.securityClearAudit()
    await load()
  }
  const exportAudit = (): void => {
    void api.securityExportAudit()
  }
  const openWhitelistFile = (): void => {
    void api.securityOpenWhitelistFile()
  }
  const installProbe = async (id: string): Promise<void> => {
    setBusyProbe(id)
    try { await api.securityInstallProbe(id); await load() } finally { setBusyProbe(null) }
  }
  // 停用 = 直接卸载。
  const removeProbe = async (id: string): Promise<void> => {
    setBusyProbe(id)
    try { await api.securityRemoveProbe(id); await load() } finally { setBusyProbe(null) }
  }
  const reinstallProbe = async (id: string): Promise<void> => {
    setBusyProbe(id)
    try { await api.securityReinstallProbe(id); await load() } finally { setBusyProbe(null) }
  }

  const protectedCount = probes.filter((p) => p.installed && p.enabled).length
  // 有效风险判定(分类在启动器端):
  // 白名单 = 忽略检测的内容(从白名单文件读取):名单内的工具即使携带密钥也不告警。
  // 只有「工具事件 + 命中密钥标记 + 第三方工具(非官方 且 不在白名单)」才算风险。
  // 用户/助手消息只是对话内容(模型提到密钥不告警),官方 dsh 工具即使带密钥也不告警。
  const effectiveRisk = useCallback((e: SecurityAuditEvent): boolean => {
    if (!e.flags?.includes('credential')) return false
    if (e.type !== 'tool/call' && e.type !== 'tool/result') return false // 消息类不告警
    const actor = e.actor ?? ''
    if (OFFICIAL_TOOLS.has(actor)) return false                          // 官方工具不告警
    if (whitelist.includes(actor)) return false                          // 白名单(忽略检测)内的工具不告警
    return true
  }, [whitelist])

  const credentialEvents = useMemo(() => events.filter(effectiveRisk), [events, effectiveRisk])
  // 整体安全状态分级:0=绿(无风险) 1=黄(轻微疑似) 2=橙(高度疑似) 3=红(已泄露)。
  const statusLevel = useMemo(() => {
    let level = 0
    for (const e of events) {
      if (!effectiveRisk(e)) continue
      if (e.sev === 2) {
        // 完整密钥在工具调用里(被发出去)= 已泄露(红);在工具结果里 = 高度疑似(橙)。
        level = Math.max(level, e.type === 'tool/call' ? 3 : 2)
      } else {
        level = Math.max(level, 1) // 仅键名/部分模式 = 轻微疑似(黄)
      }
    }
    return level
  }, [events, effectiveRisk])
  // 展示白名单:只展示有意义的会话事件。dsh 内部调度噪音(step/*、turn/*、
  // agent/*、request/*、流式块等)一律不展示,避免时间轴刷无效信息。
  const SHOW_EVENT_TYPES = useMemo(() => new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result']), [])
  // 出现的实例列表(用于实例切换)。
  const instanceNames = useMemo(() => {
    const s = new Set<string>()
    for (const e of events) if (e.instanceName) s.add(e.instanceName)
    return [...s].sort()
  }, [events])
  // 生效的实例筛选:竖向列表模式无「全部」,默认选中第一个实例。
  const activeInstance = filterInstance ?? (viewMode === 'list' ? (instanceNames[0] ?? null) : null)
  const shown = useMemo(() => {
    return events.filter((e) => {
      if (!SHOW_EVENT_TYPES.has(e.type)) return false          // 内部噪音事件:隐藏
      if (effectiveRisk(e)) return true                          // 有效风险事件:始终展示
      if (e.type === 'tool/call' || e.type === 'tool/result') return true // 工具调用:始终展示
      return true                                                // 用户/助手消息:展示
    })
      .filter((e) => !onlyCred || effectiveRisk(e))
      .filter((e) => onlyCat === 'all' || categoryOf(e, effectiveRisk) === onlyCat)
      .filter((e) => !activeInstance || e.instanceName === activeInstance)
  }, [events, onlyCred, onlyCat, activeInstance, effectiveRisk, SHOW_EVENT_TYPES])
  // 横向轴「全部」模式:按实例分组,多个横轴并列展示。
  const byInstance = useMemo(() => {
    const m = new Map<string, SecurityAuditEvent[]>()
    for (const e of shown) {
      const k = e.instanceName ?? ''
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(e)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [shown])

  const TABS: { id: TabId; label: string }[] = [
    { id: 'timeline', label: t('security.tabTimeline') },
    { id: 'sensitive', label: t('security.tabSensitive') },
    { id: 'settings', label: t('security.tabSettings') }
  ]

  return (
    <div className="p-5 space-y-5">
      <div className="flex items-center gap-2">
        <ShieldIcon />
        <h2 className="text-[17px] font-semibold">{t('security.title')}</h2>
      </div>

      {/* tab 栏 */}
      <div className="flex gap-4 border-b" style={{ borderColor: 'var(--border)' }}>
        {TABS.map((k) => (
          <button
            key={k.id}
            className="pb-2 text-[13px] font-medium transition-colors cursor-pointer"
            style={{
              color: tab === k.id ? 'var(--accent)' : 'var(--muted)',
              borderBottom: tab === k.id ? '2px solid var(--accent)' : '2px solid transparent'
            }}
            onClick={() => setTab(k.id)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* ── 时间轴 ── */}
      {tab === 'timeline' && (
        <>
          {/* 探针已关闭:变黑 + 提示 */}
          {!probeActive && (
            <div className="card p-3 text-[13px] flex items-center gap-2"
              style={{ borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)', color: 'var(--warn)' }}>
              {t('security.probeOffHint')}
            </div>
          )}
          <div className={probeActive ? 'space-y-4' : 'space-y-4 opacity-45 pointer-events-none select-none'}>
          {/* 无探针提示 */}
          {protectedCount === 0 && (
            <div
              className="card p-3 text-[13px] flex items-center justify-between gap-3 flex-wrap"
              style={{ borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }}
            >
              <span>{t('security.noProbeHint')}</span>
              {probes.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={() => probes.filter((p) => !p.installed).forEach((p) => void installProbe(p.instanceId))}>
                  {t('security.installAll')}
                </button>
              )}
            </div>
          )}

          {/* 受保护实例 */}
          <div className="card p-3 space-y-2">
            <div className="text-[14px] font-semibold">{t('security.protectedTitle', { n: protectedCount })}</div>
            {probes.length === 0 ? (
              <div className="text-[13px] py-2 text-center" style={{ color: 'var(--muted)' }}>{t('security.noInstances')}</div>
            ) : (
              <div className="space-y-1.5">
                {probes.map((p) => {
                  const menuOpen = probeMenu === p.instanceId
                  return (
                    // 三列网格:名字自适应 / 状态固定 84px 居中 / 操作右对齐 → 状态列严格对齐
                    <div key={p.instanceId} className="grid grid-cols-[1fr_84px_1fr] items-center gap-2 text-[12.5px]">
                      <span className="truncate">{p.name}</span>
                      {/* 状态列:固定宽度居中,未安装/保护中 对齐 */}
                      <div className="flex justify-center">
                        {p.installed ? (
                          <button
                            className="flex items-center gap-0.5 text-[12px] font-medium cursor-pointer"
                            style={{ color: 'var(--ok)' }}
                            title={t('security.protectedHint')}
                            onClick={() => setProbeMenu(menuOpen ? null : p.instanceId)}
                          >
                            {t('security.protected')}
                            <span className="text-[11px] transition-transform" style={{ color: 'var(--muted)', transform: menuOpen ? 'rotate(90deg)' : 'none' }}>›</span>
                          </button>
                        ) : (
                          <span className="text-[12px]" style={{ color: 'var(--warn)' }}>{t('security.notInstalled')}</span>
                        )}
                      </div>
                      {/* 操作:右对齐,固定占位保持行高一致 */}
                      <div className="flex justify-end">
                        {!p.installed ? (
                          <button className="btn btn-primary btn-sm" disabled={busyProbe === p.instanceId} onClick={() => void installProbe(p.instanceId)}>
                            {t('security.enableProtect')}
                          </button>
                        ) : menuOpen ? (
                          <span className="flex items-center gap-1.5">
                            <button className="btn btn-ghost btn-sm" disabled={busyProbe === p.instanceId} onClick={() => void reinstallProbe(p.instanceId)}>
                              {t('security.reinstall')}
                            </button>
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--err)' }} disabled={busyProbe === p.instanceId} onClick={() => void removeProbe(p.instanceId)}>
                              {t('security.uninstall')}
                            </button>
                          </span>
                        ) : (
                          <span className="h-[26px] inline-flex items-center" style={{ color: 'var(--muted)' }}>—</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 审计时间轴:横向精简表,点开看原文 */}
          <div className="card p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-[14px] font-semibold">{t('security.timelineTitle')}</div>
              <div className="flex items-center gap-2">
                <button className="btn btn-ghost btn-sm shrink-0" onClick={() => void exportAudit()}>
                  {t('security.exportLog')}
                </button>
                <button className="btn btn-ghost btn-sm shrink-0" style={{ color: 'var(--err)' }} onClick={() => void clearAudit()}>
                  {t('security.clearHistory')}
                </button>
                <label className="flex items-center gap-1.5 text-[12px] cursor-pointer" style={{ color: 'var(--muted)' }}>
                  <input type="checkbox" checked={onlyCred} onChange={(e) => setOnlyCred(e.target.checked)} />
                  {t('security.filterCred')}
                </label>
              </div>
            </div>
            {/* 竖向列表模式:实例页切换(在类别上面,无「全部」) */}
            {viewMode === 'list' && instanceNames.length > 0 && (
              <div className="flex gap-3 border-b" style={{ borderColor: 'var(--border)' }}>
                {instanceNames.map((name) => (
                  <button
                    key={name}
                    className="pb-1.5 text-[13px] font-medium transition-colors cursor-pointer"
                    style={{
                      color: activeInstance === name ? 'var(--accent)' : 'var(--muted)',
                      borderBottom: activeInstance === name ? '2px solid var(--accent)' : '2px solid transparent'
                    }}
                    onClick={() => setFilterInstance(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
            {/* 类别筛选 */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <button className="text-[12px] rounded-full px-2 py-0.5 cursor-pointer transition-colors" style={{
                color: onlyCat === 'all' ? 'var(--text)' : 'var(--muted)',
                background: onlyCat === 'all' ? 'color-mix(in srgb, var(--border) 35%, transparent)' : 'transparent',
                border: '1px solid ' + (onlyCat === 'all' ? 'var(--border-strong)' : 'var(--border)')
              }} onClick={() => setOnlyCat('all')}>{t('security.catAll')}</button>
              {(['message', 'tool', 'malicious'] as EventCat[]).map((c) => (
                <button key={c} className="text-[12px] rounded-full px-2 py-0.5 cursor-pointer transition-colors" style={{
                  color: onlyCat === c ? CAT_COLOR[c] : 'var(--muted)',
                  background: onlyCat === c ? 'color-mix(in srgb, ' + CAT_COLOR[c] + ' 16%, transparent)' : 'transparent',
                  border: '1px solid ' + (onlyCat === c ? CAT_COLOR[c] : 'var(--border)')
                }} onClick={() => setOnlyCat(onlyCat === c ? 'all' : c)}>{t(CAT_LABEL_KEY[c])}</button>
              ))}
            </div>
            {/* 横向轴模式:实例切换 chips(含全部) */}
            {viewMode === 'axis' && instanceNames.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap border-t pt-2" style={{ borderColor: 'color-mix(in srgb, var(--border) 40%, transparent)' }}>
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('security.instanceTab')}</span>
                <button className="text-[12px] rounded-full px-2.5 py-0.5 cursor-pointer transition-colors" style={{
                  color: filterInstance === null ? 'var(--accent)' : 'var(--muted)',
                  background: filterInstance === null ? 'var(--accent-soft)' : 'transparent',
                  border: '1px solid ' + (filterInstance === null ? 'var(--accent)' : 'var(--border)')
                }} onClick={() => setFilterInstance(null)}>{t('security.instanceAll')}</button>
                {instanceNames.map((name) => (
                  <button key={name} className="text-[12px] rounded-full px-2.5 py-0.5 cursor-pointer transition-colors" style={{
                    color: filterInstance === name ? 'var(--accent)' : 'var(--muted)',
                    background: filterInstance === name ? 'var(--accent-soft)' : 'transparent',
                    border: '1px solid ' + (filterInstance === name ? 'var(--accent)' : 'var(--border)')
                  }} onClick={() => setFilterInstance(filterInstance === name ? null : name)}>{name}</button>
                ))}
              </div>
            )}
            {shown.length === 0 ? (
              <div className="text-[13px] py-4 text-center" style={{ color: 'var(--muted)' }}>{t('security.noEvents')}</div>
            ) : viewMode === 'list' ? (
              <VerticalTimeline
                events={shown.slice(0, 200)}
                onOpen={setDetail}
                riskOf={effectiveRisk}
                catOf={categoryOf}
                t={t}
              />
            ) : filterInstance ? (
              /* 选中单个实例:单个横轴 */
              <HorizontalTimeline
                events={shown.slice(0, 80)}
                onOpen={setDetail}
                riskOf={effectiveRisk}
                catOf={categoryOf}
                t={t}
              />
            ) : (
              /* 全部实例:每个实例一个横轴,并列展示 */
              <div className="space-y-4">
                {byInstance.map(([name, evs]) => (
                  <div key={name}>
                    <div className="text-[12px] font-semibold mb-1" style={{ color: 'var(--muted)' }}>{name || t('security.instanceUnknown')}</div>
                    <HorizontalTimeline
                      events={evs.slice(0, 80)}
                      onOpen={setDetail}
                      riskOf={effectiveRisk}
                      catOf={categoryOf}
                      t={t}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          </div>{/* /dim 包装 */}
        </>
      )}

      {/* ── 风险内容 ── */}
      {tab === 'sensitive' && (
        <div className="space-y-4">
          {/* 探针已关闭:变黑 + 提示 */}
          {!probeActive && (
            <div className="card p-3 text-[13px] flex items-center gap-2"
              style={{ borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)', background: 'color-mix(in srgb, var(--warn) 8%, transparent)', color: 'var(--warn)' }}>
              {t('security.probeOffHint')}
            </div>
          )}
          <div className={probeActive ? 'space-y-4' : 'space-y-4 opacity-45 pointer-events-none select-none'}>
          {/* 整体安全状态:旋转流光边框 + 正在保护中 */}
          {(() => {
            const s = RISK_LEVELS[statusLevel]
            const isAlert = statusLevel >= 1
            return (
              <div className="security-glow" style={{ '--glow': s.color } as React.CSSProperties}>
                <div className="security-glow-inner">
                  <div className="p-4 flex items-center gap-4">
                    {/* 光球 */}
                    <div
                      className="rounded-full shrink-0"
                      style={{
                        width: 30,
                        height: 30,
                        background: s.color,
                        boxShadow: `0 0 0 6px color-mix(in srgb, ${s.color} 22%, transparent), 0 0 18px ${s.color}55`
                      }}
                    />
                    {/* 中间:状态文案(告警时替换文字) */}
                    <div className="flex-1 min-w-0 text-left">
                      <div className="text-[15px] font-semibold" style={{ color: s.color }}>
                        {isAlert ? t(s.label) : t('security.protecting')}
                      </div>
                      <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
                        {isAlert ? t('security.statusHint', { n: credentialEvents.length }) : t('security.protectingHint')}
                      </div>
                    </div>
                    {/* 靠右:风险计数 */}
                    <div className="text-right shrink-0">
                      <div className="text-[22px] font-bold" style={{ color: s.color }}>{credentialEvents.length}</div>
                      <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('security.riskEvents')}</div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* 风险事件列表(按等级着色,点开看详情弹窗) */}
          <div className="card p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[14px] font-semibold">{t('security.apikeyTitle')}</div>
              <button className="btn btn-ghost btn-sm shrink-0" style={{ color: 'var(--err)' }} onClick={() => void clearAudit()}>
                {t('security.reset')}
              </button>
            </div>
            {credentialEvents.length === 0 ? (
              <div className="text-[13px] py-3 text-center" style={{ color: 'var(--muted)' }}>{t('security.noEvents')}</div>
            ) : (
              <div className="max-h-[50vh] overflow-y-auto space-y-1">
                {credentialEvents.slice(0, 200).map((e, i) => (
                  <button
                    key={i}
                    className="w-full text-[12.5px] rounded px-2 py-1.5 flex items-center justify-between gap-2 text-left cursor-pointer transition-colors hover:opacity-85"
                    style={{ background: 'color-mix(in srgb, ' + riskColor(e) + ' 12%, transparent)' }}
                    onClick={() => setDetail(e)}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: riskColor(e) }} />
                      <span className="truncate" style={{ color: riskColor(e) }}>
                        {fmtTime(e.t)} · {TYPE_ZH[e.type] ?? e.type} · {e.actor ?? '—'}
                      </span>
                    </span>
                    <span className="shrink-0 flex items-center gap-1.5">
                      {e.key && <span className="mono text-[11px] rounded px-1 py-0.5" style={{ color: riskColor(e), background: 'color-mix(in srgb, ' + riskColor(e) + ' 16%, transparent)' }}>{e.key}</span>}
                      <span className="mono shrink-0 text-[11px]" style={{ color: 'var(--muted)' }}>{e.sid.slice(0, 10)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          </div>{/* /dim 包装 */}
        </div>
      )}

      {/* ── 设置 ── */}
      {tab === 'settings' && (
        <div className="max-w-2xl space-y-4">
          {/* 安全设置:大卡片,系统设置风格 */}
          <div className="card p-5 space-y-4">
            <div>
              <div className="text-[15px] font-semibold">{t('security.settingsTitle')}</div>
              <div className="text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>{t('security.settingsSubtitle')}</div>
            </div>
            <div className="flex items-center justify-between gap-4 py-3 border-t" style={{ borderColor: 'color-mix(in srgb, var(--border) 45%, transparent)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium">{t('security.probeEnabled')}</div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>{t('security.probeEnabledHint')}</div>
              </div>
              <Toggle checked={cfg?.probeEnabled !== false} onChange={(v) => void setCfgField('probeEnabled', v)} />
            </div>
            {/* 时间轴展示方式 */}
            <div className="flex items-center justify-between gap-4 py-3 border-t" style={{ borderColor: 'color-mix(in srgb, var(--border) 45%, transparent)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium">{t('security.viewMode')}</div>
                <div className="text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>{t('security.viewModeHint')}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0 rounded-[8px] border p-0.5" style={{ borderColor: 'var(--border)' }}>
                {(['axis', 'list'] as const).map((m) => (
                  <button
                    key={m}
                    className="px-2.5 py-1 text-[12px] rounded-[6px] cursor-pointer transition-colors"
                    style={{
                      color: viewMode === m ? 'var(--accent)' : 'var(--muted)',
                      background: viewMode === m ? 'var(--accent-soft)' : 'transparent'
                    }}
                    onClick={() => setViewMode(m)}
                  >
                    {m === 'axis' ? t('security.viewAxis') : t('security.viewList')}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('security.settingsHint')}</div>
          </div>

          {/* 白名单:忽略检测的内容 */}
          <div className="card p-5 space-y-3">
            <div>
              <div className="text-[15px] font-semibold">{t('security.whitelistTitle')}</div>
              <div className="text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>{t('security.whitelistHint')}</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={openWhitelistFile}>{t('security.openWhitelistFile')}</button>
          </div>
        </div>
      )}

      {/* 事件详情弹窗 */}
      <EventDetailModal event={detail} onClose={() => setDetail(null)} riskOf={effectiveRisk} t={t} />
    </div>
  )
}
