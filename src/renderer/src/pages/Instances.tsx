import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api, type DshInstance, type PluginMatrixResult } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { Toggle } from '../components/Toggle'
import { TaskConsole } from '../components/TaskConsole'
import { CopyButton } from '../components/CopyButton'
import { PlayIcon, StopIcon, TrashIcon, PlusIcon } from '../lib/icons'
import { RECOMMENDED_BUNDLES, bundleCount, bundleTaskLabel, type RecommendedBundle } from '../../../shared/bundles'

function statusColor(st: string): string {
  return st === 'running' || st === 'external'
    ? 'var(--ok)'
    : st === 'starting' || st === 'stopping'
      ? 'var(--accent)'
      : st === 'error'
        ? 'var(--err)'
        : 'var(--muted)'
}

/** Shared modal shell: dark overlay, click outside to close. */
function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }): JSX.Element {
  const { t } = useI18n()
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className={`panel w-full ${wide ? 'max-w-2xl min-h-[640px]' : 'max-w-md'} max-h-[85vh] overflow-y-auto p-5 space-y-4`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate text-[16px] font-semibold">{title}</h3>
          <button className="btn btn-ghost btn-sm !p-1 shrink-0" onClick={onClose} title={t('instances.close')}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** 「问/答」条目。 */
interface QaItem {
  q: string
  a: string
}

/** Q&A 弹窗:「关于整合包」/「什么是实例?」共用,仿整合包说明的问答形式。 */
function QaModal({ title, qa, onClose }: { title: string; qa: QaItem[]; onClose: () => void }): JSX.Element {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        {qa.map((item, i) => (
          <div key={i} className="space-y-1.5">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
              Q{i + 1}. {item.q}
            </div>
            <p className="select-text text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              {item.a}
            </p>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/** Settings-form subset for one instance (profile is fixed at creation, not editable here). */
interface InstanceForm {
  name: string
  description: string
  port: number
  autoStart: boolean
  enabled: boolean
}

/** Full editor for one instance, opened by clicking its card. Two tabs: settings / enabled plugins. */
function EditInstanceModal({ inst, onClose }: { inst: DshInstance; onClose: () => void }): JSX.Element {
  const { t, statusLabel } = useI18n()
  const { states, instances, activeInstanceId, setActiveInstance, refresh } = useHarness()
  const [form, setForm] = useState<InstanceForm>({
    name: inst.name,
    description: inst.description ?? '',
    port: inst.port,
    autoStart: inst.autoStart,
    enabled: inst.enabled !== false
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [tab, setTab] = useState<'settings' | 'plugins'>('settings')
  const [matrix, setMatrix] = useState<PluginMatrixResult | null>(null)
  const [pluginBusy, setPluginBusy] = useState<string | null>(null)
  const st = states[inst.id]?.status ?? 'stopped'
  const isActive = inst.id === activeInstanceId
  const canStop = st !== 'stopped' && st !== 'error'

  const set = <K extends keyof InstanceForm>(k: K, v: InstanceForm[K]): void => {
    setForm((f) => ({ ...f, [k]: v }))
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    try {
      await api.updateInstance(inst.id, {
        name: form.name.trim() || inst.name,
        description: form.description ?? '',
        port: Number(form.port) || 0,
        autoStart: form.autoStart,
        enabled: form.enabled !== false
      })
      await refresh()
      onClose()
    } finally {
      setBusy(null)
    }
  }

  const toggleStart = async (): Promise<void> => {
    setBusy('start')
    try {
      if (canStop) await api.stopInstance(inst.id)
      else await api.startInstance(inst.id)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    // 删除只移除配置条目,磁盘上的数据目录 / profile / 会话全部保留(2026-08-19 决策,
    // 防止任何误删风险);如确定不要垃圾,可自行手动清理对应目录。
    if (!window.confirm(t('settings.confirmRemoveInstance', { name: inst.name }))) return
    setBusy('remove')
    try {
      await api.removeInstance(inst.id)
      await refresh()
      onClose()
    } finally {
      setBusy(null)
    }
  }

  // Enabled-plugins tab: pull the plugin×instance matrix and poll so plugin-set
  // changes (which restart the harness) converge without manual refresh.
  const loadMatrix = useCallback(async (): Promise<void> => {
    try {
      setMatrix(await api.listPluginMatrix())
    } catch {
      /* non-fatal */
    }
  }, [])

  useEffect(() => {
    if (tab !== 'plugins') return
    void loadMatrix()
    const id = setInterval(() => void loadMatrix(), 4000)
    return () => clearInterval(id)
  }, [tab, loadMatrix])

  const enabledRows = useMemo(() => {
    const cells = matrix?.cells ?? {}
    return (matrix?.rows ?? []).filter((r) => cells[r.name]?.[inst.id] === 'enabled')
  }, [matrix, inst.id])

  const disablePlugin = async (name: string, displayName: string): Promise<void> => {
    if (!window.confirm(t('plugins.disableConfirm', { name: displayName }))) return
    setPluginBusy(name)
    try {
      await api.disablePlugin(inst.id, name)
      await loadMatrix()
    } finally {
      setPluginBusy(null)
    }
  }

  return (
    <Modal title={t('instances.edit')} onClose={onClose} wide>
      {/* Settings / enabled plugins */}
      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {(
          [
            ['settings', t('instances.tabSettings')],
            ['plugins', t('instances.tabPlugins')]
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className="border-b-2 px-3 pb-2 text-[13px] font-medium transition-colors"
            style={{
              color: tab === key ? 'var(--accent)' : 'var(--muted)',
              borderColor: tab === key ? 'var(--accent)' : 'transparent'
            }}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'settings' ? (
        <>
          <div>
            <label className="label">{t('settings.instanceName')}</label>
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>

          <div>
            <label className="label">{t('instances.description')}</label>
            <textarea
              className="input resize-none"
              rows={2}
              value={form.description}
              placeholder={t('instances.noDescription')}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>

          <div className="max-w-[220px]">
            <label className="label">{t('settings.instancePort')}</label>
            <input
              className="input mono"
              type="number"
              min={0}
              value={form.port}
              onChange={(e) => set('port', Number(e.target.value) || 0)}
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center justify-between gap-3 text-[13px] cursor-pointer">
              <span>{t('settings.instanceAutoStart')}</span>
              <Toggle checked={form.autoStart} onChange={(v) => set('autoStart', v)} />
            </label>
            <label className="flex items-center justify-between gap-3 text-[13px] cursor-pointer">
              <span>{t('instances.show')}</span>
              <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} />
            </label>
          </div>

          <div className="space-y-1 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 text-[12.5px]">
              <span className="badge-dot" style={{ background: statusColor(st) }} />
              <span style={{ color: 'var(--muted)' }}>{statusLabel(st)}</span>
              {isActive && (
                <span className="badge" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                  {t('settings.isActive')}
                </span>
              )}
            </div>
            <div className="break-all text-[12px]" style={{ color: 'var(--muted)' }}>
              {t('instances.workspace')} <span className="mono">{inst.workspace ?? '—'}</span>
            </div>
            <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
              <span className="break-all">{t('instances.dshHome')} <span className="mono">{inst.dshHome ?? '—'}</span></span>
              {!inst.dshHome && (
                <span className="badge shrink-0" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                  {t('instances.homeShared')}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            {!isActive && (
              <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void setActiveInstance(inst.id)}>
                {t('settings.setActive')}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void toggleStart()}>
              {canStop ? <StopIcon /> : <PlayIcon />} {canStop ? t('settings.stopInstance') : t('settings.startInstance')}
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <button
              className="btn btn-danger btn-sm shrink-0"
              disabled={busy !== null || instances.length <= 1}
              title={instances.length <= 1 ? t('settings.cantDeleteLast') : undefined}
              onClick={() => void remove()}
            >
              <TrashIcon /> {t('settings.deleteInstance')}
            </button>
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost btn-sm" onClick={onClose}>
                {t('instances.close')}
              </button>
              <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void save()}>
                {t('instances.save')}
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          {enabledRows.length === 0 ? (
            <div className="py-6 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
              {t('instances.noPluginsEnabled')}
            </div>
          ) : (
            <div className="space-y-2">
              {enabledRows.map((row) => (
                <div key={row.name} className="flex items-center gap-3 rounded border p-3" style={{ borderColor: 'var(--border)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                        {row.displayName}
                      </span>
                      {row.version && (
                        <span className="badge shrink-0" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                          v{row.version}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 line-clamp-1 break-words text-[12px]" style={{ color: 'var(--muted)' }}>
                      {row.remark || row.description || row.name}
                    </div>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm shrink-0"
                    disabled={pluginBusy !== null}
                    onClick={() => void disablePlugin(row.name, row.displayName)}
                  >
                    {t('plugins.matrix.disable')}
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="pt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
            {t('instances.pluginsHint')}
          </p>
        </>
      )}
    </Modal>
  )
}

/**
 * 数据目录 (DSH_HOME) 选择:共享(可指定目标 home,选项悬停显示该目录下的实例与地址)
 * 或独立(全新目录)。新建实例表单与整合包下载弹窗共用。
 */
function HomeModePicker({
  value,
  onChange
}: {
  value: { homeMode: 'shared' | 'isolated'; home: string }
  onChange: (v: { homeMode: 'shared' | 'isolated'; home: string }) => void
}): JSX.Element {
  const { t, lang } = useI18n()
  const { config, instances } = useHarness()
  // 自定义共享目标下拉:原生 <option> 不支持悬停详情,用手绘面板
  const [homeOpen, setHomeOpen] = useState(false)
  const [hoverHome, setHoverHome] = useState<number | null>(null)
  const homeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!homeOpen) return
    const h = (e: MouseEvent): void => {
      if (homeRef.current && !homeRef.current.contains(e.target as Node)) setHomeOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [homeOpen])

  // 共享目标候选:全局 home + 各实例的独立 home(去重),标注该 home 下有哪些实例。
  const shareTargets = useMemo(() => {
    const homes = new Map<string, string[]>()
    const cfgHome = config?.dshHome
    if (cfgHome) homes.set(cfgHome, [t('settings.homeSharedDefault')])
    for (const i of instances) {
      const h = i.dshHome ?? cfgHome
      if (!h) continue
      if (!homes.has(h)) homes.set(h, [])
      homes.get(h)!.push(i.name)
    }
    return [...homes.entries()]
  }, [instances, config?.dshHome, t])

  return (
    <div className="space-y-2">
      {(
        [
          ['shared', t('settings.homeModeShared'), t('settings.homeModeSharedHint')],
          ['isolated', t('settings.homeModeIsolated'), t('settings.homeModeIsolatedHint')]
        ] as const
      ).map(([mode, label, hint]) => (
        <label key={mode} className="flex cursor-pointer items-start gap-2 text-[13px]">
          <input
            type="radio"
            name="homeMode"
            className="mt-0.5"
            checked={value.homeMode === mode}
            onChange={() => onChange({ ...value, homeMode: mode })}
          />
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="flex items-center gap-2">
              <span className="font-medium shrink-0" style={{ color: 'var(--text)' }}>{label}</span>
              {mode === 'shared' && value.homeMode === 'shared' && (
                <div ref={homeRef} className="relative ml-auto shrink-0">
                  <button
                    type="button"
                    className="input flex h-8 w-auto min-w-[90px] max-w-[110px] items-center justify-between gap-1 rounded-lg border px-2 py-1 text-[12px] font-medium"
                    title={
                      (() => {
                        const cur = shareTargets.find(([h]) => h === value.home)
                        return cur ? `${cur[1].join(lang === 'zh' ? '、' : ', ')} · ${value.home}` : value.home
                      })()
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      setHomeOpen((o) => !o)
                    }}
                  >
                    <span className="truncate">
                      Home {(shareTargets.findIndex(([h]) => h === value.home) + 1) || 1}
                    </span>
                    <span className="text-[9px] opacity-60">▾</span>
                  </button>
                  {homeOpen && (
                    <div
                      className="absolute right-0 top-full z-20 mt-1 w-[300px] space-y-0.5 rounded-lg border p-1.5 shadow-lg"
                      style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                    >
                      {shareTargets.map(([home, names], idx) => (
                        <div
                          key={home}
                          className="cursor-pointer rounded-md px-2 py-1.5 text-[12px]"
                          style={hoverHome === idx ? { background: 'var(--accent-soft)' } : undefined}
                          onClick={(e) => {
                            e.stopPropagation()
                            onChange({ ...value, home })
                            setHomeOpen(false)
                          }}
                          onMouseEnter={() => setHoverHome(idx)}
                        >
                          <span className="font-medium">Home {idx + 1}</span>
                          {hoverHome === idx && (
                            <span
                              className="mt-0.5 block break-all text-[10.5px] leading-relaxed"
                              style={{ color: 'var(--muted)' }}
                            >
                              {names.join(lang === 'zh' ? '、' : ', ')} · {home}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </span>
            <span className="block text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>{hint}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

/** New-instance form as a modal (name + note + profile/port + auto-start + optional session import). */
function NewInstanceModal({ onClose }: { onClose: () => void }): JSX.Element {
  const { t, lang } = useI18n()
  const { config, instances, activeInstanceId, refresh } = useHarness()
  const [form, setForm] = useState({
    name: '',
    description: '',
    profile: '',
    port: 0,
    autoStart: false,
    homeMode: 'shared' as 'shared' | 'isolated',
    home: ''
  })
  // 默认共享到全局 home(现状行为);config 到达后补一次初值。
  useEffect(() => {
    if (config?.dshHome) setForm((f) => ({ ...f, home: f.home || config.dshHome! }))
  }, [config?.dshHome])
  const [busy, setBusy] = useState(false)
  const profileDefaulted = useRef(false)
  useEffect(() => {
    if (profileDefaulted.current || !activeInstanceId) return
    const act = instances.find((i) => i.id === activeInstanceId)
    if (act) {
      profileDefaulted.current = true
      setForm((f) => ({ ...f, profile: act.profile }))
    }
  }, [instances, activeInstanceId])

  const create = async (): Promise<void> => {
    if (!form.name.trim()) return
    setBusy(true)
    try {
      await api.addInstance({
        name: form.name.trim(),
        description: form.description.trim(),
        profile: form.profile.trim() || 'web',
        port: Number(form.port) || 0,
        autoStart: form.autoStart,
        homeMode: form.homeMode,
        home: form.homeMode === 'shared' ? form.home : undefined
      })
      await refresh()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('settings.addInstance')} onClose={onClose}>
      <div>
        <label className="label">{t('settings.instanceName')}</label>
        <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
      </div>
      <div>
        <label className="label">{t('instances.description')}</label>
        <textarea
          className="input resize-none"
          rows={2}
          value={form.description}
          placeholder={t('instances.noDescription')}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{t('settings.instanceProfileBase')}</label>
          <input className="input mono" value={form.profile} readOnly title={t('settings.instanceProfileAuto')} />
        </div>
        <div>
          <label className="label">{t('settings.instancePort')}</label>
          <input
            className="input mono"
            type="number"
            min={0}
            value={form.port}
            onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) || 0 }))}
          />
        </div>
      </div>
      <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
        {t('settings.instanceProfileAuto')}
      </p>
      <label className="flex items-center gap-2 text-[13px] cursor-pointer">
        <Toggle checked={form.autoStart} onChange={(v) => setForm((f) => ({ ...f, autoStart: v }))} />
        {t('settings.instanceAutoStart')}
      </label>

      {/* 数据目录:共享到某个已有 home(下拉选择目标),或独立(全新 DSH_HOME,完全隔离) */}
      <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <label className="label">{t('settings.homeModeLabel')}</label>
        <HomeModePicker
          value={{ homeMode: form.homeMode, home: form.home }}
          onChange={(v) => setForm((f) => ({ ...f, homeMode: v.homeMode, home: v.home }))}
        />
      </div>
      <div className="flex justify-end gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          {t('instances.close')}
        </button>
        <button className="btn btn-primary btn-sm" disabled={busy || !form.name.trim()} onClick={() => void create()}>
          {t('settings.instanceAddBtn')}
        </button>
      </div>
    </Modal>
  )
}

/** 整合包下载前的数据目录确认:新实例的 home 模式(共享到哪个目录 / 全新独立目录)。 */
function BundleHomeModal({
  bundle,
  onClose,
  onDownload
}: {
  bundle: RecommendedBundle
  onClose: () => void
  onDownload: (opts: { homeMode: 'shared' | 'isolated'; home?: string }) => void
}): JSX.Element {
  const { t } = useI18n()
  const { config } = useHarness()
  const [homeMode, setHomeMode] = useState<'shared' | 'isolated'>('shared')
  const [home, setHome] = useState('')
  // 默认共享到全局 home;config 到达后补一次初值。
  useEffect(() => {
    if (config?.dshHome) setHome((h) => h || config.dshHome!)
  }, [config?.dshHome])

  return (
    <Modal title={t('instances.bundleHomeTitle')} onClose={onClose}>
      <p className="mb-3 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
        {t('instances.bundleHomeHint', { name: bundle.name })}
      </p>
      <HomeModePicker
        value={{ homeMode, home }}
        onChange={(v) => {
          setHomeMode(v.homeMode)
          setHome(v.home)
        }}
      />
      <div className="flex justify-end gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          {t('instances.close')}
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => onDownload({ homeMode, home: homeMode === 'shared' ? home : undefined })}>
          {t('instances.startDownload')}
        </button>
      </div>
    </Modal>
  )
}

/** Bundle detail modal: 整合包的社区插件清单(含中文简介),全部来自固化的静态数据。 */
function BundleDetailModal({
  bundle,
  busy,
  installed,
  onClose,
  onDownload
}: {
  bundle: RecommendedBundle
  busy: boolean
  installed: boolean
  onClose: () => void
  onDownload: () => void
}): JSX.Element {
  const { t } = useI18n()

  return (
    <Modal title={bundle.name} onClose={onClose} wide>
      {installed && (
        <span className="badge mb-2" style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }}>
          {t('instances.downloaded')}
        </span>
      )}
      {bundle.description && (
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          {bundle.description}
        </p>
      )}

      {/* 社区插件(计入数量) */}
      <div>
        <label className="label">{t('instances.bundleCommunity', { count: bundle.community.length })}</label>
        <div className="space-y-1.5">
          {bundle.community.map((p) => (
            <div key={p.spec ?? p.name} className="rounded border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2">
                <span className="mono min-w-0 flex-1 truncate text-[12px]" style={{ color: 'var(--text)' }} title={p.spec}>
                  {p.name ?? p.spec}
                </span>
                <span className="badge shrink-0" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                  {t('instances.bundleGroupCommunity')}
                </span>
              </div>
              {p.description && (
                <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                  {p.description}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          {t('instances.close')}
        </button>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={onDownload}>
          {installed ? t('instances.redownload') : t('instances.downloadBundle')}
        </button>
      </div>
    </Modal>
  )
}

/**
 * 整合包下载进度弹窗:显示整体百分比 + 当前阶段 + 实时日志。
 * 数据来自 installBundle 按包广播的整合包总进度任务(bundleTaskLabel(bundle)),不是独立请求。
 */
function BundleProgressModal({
  bundle,
  warnings,
  failedSpecs,
  onRetry,
  onClose
}: {
  bundle: RecommendedBundle
  warnings: string[]
  /** 失败插件的 spec 清单(bundleFailed),非空时显示「一键重试」按钮。 */
  failedSpecs: string[]
  onRetry: () => void
  onClose: () => void
}): JSX.Element {
  const { t } = useI18n()
  const { tasks } = useHarness()
  const task = tasks[bundleTaskLabel(bundle)]
  const running = task?.running ?? false
  const endedOk = task != null && !running && (task.code === 0 || task.progress === 1)
  const failed = task != null && !running && task.code != null && task.code !== 0
  const pct = task?.progress != null ? Math.round(task.progress * 100) : 0

  const status = running
    ? t('instances.bundleProgressRunning')
    : endedOk
      ? t('instances.bundleProgressDone')
      : failed
        ? t('instances.bundleProgressFailed')
        : t('instances.bundleProgressIdle')

  return (
    <Modal title={t('instances.bundleProgress')} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex items-end gap-3">
          <span className="mono text-[34px] font-semibold leading-none">{pct}%</span>
          <span className="pb-0.5 text-[12px]" style={{ color: 'var(--muted)' }}>
            {status}
          </span>
        </div>
        {task?.phase && (
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            {task.phase}
          </p>
        )}
        {task ? (
          <TaskConsole task={task} />
        ) : (
          <div className="rounded-lg border p-4 text-[12px]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
            {t('instances.bundleProgressPreparing')}
          </div>
        )}
        {endedOk && warnings.length > 0 && (
          <div className="select-text space-y-1 rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium">{t('instances.bundleWarningsTitle')}</div>
              <div className="flex shrink-0 items-center gap-2">
                {failedSpecs.length > 0 && (
                  <button className="btn btn-primary btn-sm" onClick={onRetry} disabled={running}>
                    {t('instances.bundleRetryFailed')}
                  </button>
                )}
                <CopyButton text={warnings.join('\n')} title={t('common.copyAll')} />
              </div>
            </div>
            {warnings.map((w, i) => (
              <p key={i} className="leading-relaxed">
                ⚠ {w}
              </p>
            ))}
          </div>
        )}
        <div className="flex justify-end border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('instances.close')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/** A small card per instance: name + user-set note + an enable/hide toggle. Click to edit. */
function InstanceCard({ inst, onOpen }: { inst: DshInstance; onOpen: () => void }): JSX.Element {
  const { t } = useI18n()
  const { states, refresh } = useHarness()
  const st = states[inst.id]?.status ?? 'stopped'
  const hidden = inst.enabled === false

  const toggle = async (v: boolean): Promise<void> => {
    await api.updateInstance(inst.id, { enabled: v })
    await refresh()
  }

  return (
    <div
      className="card h-[104px] p-4 cursor-pointer select-none space-y-2 transition-opacity"
      onClick={onOpen}
      title={t('instances.edit')}
      style={{ opacity: hidden ? 0.55 : 1 }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="badge-dot shrink-0" style={{ background: statusColor(st) }} />
          <span className="truncate text-[13px] font-semibold">{inst.name}</span>
          {hidden && (
            <span
              className="badge shrink-0"
              style={{ color: 'var(--muted)', background: 'color-mix(in srgb, var(--muted) 14%, transparent)' }}
            >
              {t('instances.hidden')}
            </span>
          )}
        </div>
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
          title={t('instances.show')}
        >
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            {t('instances.show')}
          </span>
          <Toggle checked={!hidden} onChange={(v) => void toggle(v)} />
        </label>
      </div>
      <div
        className="line-clamp-2 min-h-[30px] break-words text-[11.5px] leading-relaxed"
        style={{ color: 'var(--muted)' }}
      >
        {inst.description || <span className="opacity-60">{t('instances.noDescription')}</span>}
      </div>
    </div>
  )
}

export function Instances(): JSX.Element {
  const { t } = useI18n()
  const { instances, refresh, tasks } = useHarness()
  const [editing, setEditing] = useState<DshInstance | null>(null)
  const [creating, setCreating] = useState(false)
  const [bundleBusy, setBundleBusy] = useState<string | null>(null)
  const [bundleError, setBundleError] = useState<string | null>(null)
  const [bundleNote, setBundleNote] = useState<string[] | null>(null)
  // 失败插件的 spec 清单(带归属整合包):驱动「一键重试」按钮。
  const [bundleFailed, setBundleFailed] = useState<{ bundle: RecommendedBundle; specs: string[] } | null>(null)
  // 待下载整合包的数据目录确认弹窗:点「下载」先选共享/独立 + 目标 home,再开始安装。
  const [homePick, setHomePick] = useState<RecommendedBundle | null>(null)
  const [viewing, setViewing] = useState<RecommendedBundle | null>(null)
  // 整合包下载进度弹窗:点「下载」即打开,结束后可手动关闭(后台任务不受影响)。
  // 记录当前展示的包,进度标签按包派生(多整合包并存时各看各的)。
  const [progressBundle, setProgressBundle] = useState<RecommendedBundle | null>(null)
  // 防呆:state 更新是异步的,连点两次可能在 render 前连跑两次 downloadBundle;
  // 用 ref 做同步门闩,installBundle 本身虽幂等复用同名实例,但重复触发仍会重跑一遍安装。
  const bundleInFlight = useRef<string | null>(null)
  // 「关于整合包」/「什么是实例?」问答弹窗
  const [qa, setQa] = useState<'bundle' | 'instance' | null>(null)

  const downloadBundle = async (
    bundle: RecommendedBundle,
    options?: { homeMode?: 'shared' | 'isolated'; home?: string; retrySpecs?: string[] }
  ): Promise<void> => {
    if (bundleInFlight.current !== null) return
    bundleInFlight.current = bundle.id
    setBundleBusy(bundle.id)
    setBundleError(null)
    setBundleNote(null)
    setBundleFailed(null)
    setProgressBundle(bundle)
    // 从详情弹窗发起下载时,先关掉详情,让进度弹窗独占屏幕。
    setViewing(null)
    try {
      // options:homeMode/home = 新建实例的数据目录选择;retrySpecs = 上次失败的 spec 清单,
      // main 侧只重装这些插件,不重建实例、不重装已成功的。
      const r = await api.installBundle(bundle.id, options)
      if (!r.ok) {
        setBundleError(r.error ?? t('instances.bundleDownloadFailed'))
        return
      }
      // Non-fatal notes (skipped sub-packages, failed plugins, …):逐条列出,
      // 进度弹窗与页面卡片下方都会展示,方便用户知道哪些没装上。
      if (r.warnings?.length) setBundleNote(r.warnings)
      // 失败插件的 spec 清单:供「一键重试」按钮原样传回 installBundle。
      if (r.bundleFailed?.length) setBundleFailed({ bundle, specs: r.bundleFailed })
      // Reload the config so the freshly-created instance shows up in the grid.
      await refresh()
    } finally {
      bundleInFlight.current = null
      setBundleBusy(null)
    }
  }

  /** 一键重试失败插件:只对上次失败的 spec 重新 `dsh plugin add`,成功项不动。 */
  const retryFailedPlugins = async (bundle: RecommendedBundle): Promise<void> => {
    const failed = bundleFailed
    if (!failed || failed.specs.length === 0 || failed.bundle.id !== bundle.id) return
    await downloadBundle(bundle, { retrySpecs: failed.specs })
  }

  // 防呆:同名实例已存在 = 整合包已下载过 → 卡片按钮置灰显示「已下载」,
  // 避免用户多次点同一个整合包的下载;仍可从详情弹窗显式「重新下载」。
  const installedNames = useMemo(() => new Set(instances.map((i) => i.name)), [instances])

  return (
    <div className="p-5 space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[18px] font-semibold">{t('nav.instances')}</h2>
          <button
            type="button"
            className="shrink-0 text-[12px] transition-colors hover:text-[var(--accent)] hover:underline"
            style={{ color: 'var(--muted)' }}
            onClick={() => setQa('instance')}
          >
            {t('instances.whatIsInstance')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {instances.map((inst) => (
          <InstanceCard key={inst.id} inst={inst} onOpen={() => setEditing(inst)} />
        ))}
        {/* 新建实例入口:与实例卡片同尺寸的虚线框(不填充背景),放在网格末尾 */}
        <button
          className="h-[104px] p-4 flex select-none cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed transition-colors"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--muted)', background: 'transparent' }}
          onClick={() => setCreating(true)}
          title={t('settings.addInstance')}
        >
          <PlusIcon />
          <span className="text-[13px] font-semibold">{t('settings.addInstance')}</span>
        </button>
      </div>

      {/* Recommended bundles: download a bundle to get a new pre-configured instance. */}
      <div className="border-t pt-4" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2.5">
          <h3 className="text-[13px] font-medium" style={{ color: 'var(--muted)' }}>
            {t('instances.recommendedBundles')}
          </h3>
          <button
            type="button"
            className="shrink-0 text-[12px] transition-colors hover:text-[var(--accent)] hover:underline"
            style={{ color: 'var(--muted)' }}
            onClick={() => setQa('bundle')}
          >
            {t('instances.aboutBundle')}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {RECOMMENDED_BUNDLES.map((bundle) => {
            // 下载中判定:installBundle 进行中(bundleBusy)且该包有进度任务;
            // 点击卡片回到进度弹窗而不是重复下载,百分比从总进度任务实时取。
            const task = tasks[bundleTaskLabel(bundle)]
            const downloading = bundleBusy === bundle.id
            const pct = task?.progress != null ? Math.round(task.progress * 100) : 0
            return (
            <div
              key={bundle.id}
              className={`card space-y-2 cursor-pointer select-none p-4 transition-opacity ${downloading ? 'pulse-live' : ''}`}
              onClick={() => (downloading ? setProgressBundle(bundle) : setViewing(bundle))}
              title={downloading ? t('instances.bundleOpenProgress') : t('instances.bundleDetails')}
            >
              <div className="text-[13px] font-semibold">{bundle.name}</div>
              <div className="line-clamp-2 min-h-[30px] break-words text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                {bundle.description}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[11px] mono" style={{ color: 'var(--muted)' }}>
                  {t('instances.bundlePluginCount', { count: bundleCount(bundle) })}
                </span>
              </div>
              {downloading && (
                <div className="flex items-center gap-2">
                  <div
                    className="h-1.5 flex-1 overflow-hidden rounded-full"
                    style={{ background: 'color-mix(in srgb, var(--accent) 18%, transparent)' }}
                  >
                    <div
                      className="h-full animate-pulse rounded-full transition-[width] duration-300"
                      style={{ background: 'var(--accent)', width: `${Math.max(pct, 4)}%` }}
                    />
                  </div>
                  <span className="mono shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--accent)' }}>
                    {pct}%
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={installedNames.has(bundle.name) || (bundleBusy !== null && bundleBusy !== bundle.id)}
                  onClick={(e) => {
                    e.stopPropagation()
                    // 下载中:点击当前整合包的按钮 = 重新打开进度弹窗,而不是重复下载。
                    if (bundleBusy === bundle.id) {
                      setProgressBundle(bundle)
                      return
                    }
                    // 已下载过:卡片按钮置灰,不重复触发(想重装去详情弹窗)。
                    if (installedNames.has(bundle.name)) return
                    // 未安装:先弹数据目录确认(共享/独立 + 目标 home),再开始安装。
                    setHomePick(bundle)
                  }}
                >
                  {bundleBusy === bundle.id
                    ? t('instances.downloading')
                    : installedNames.has(bundle.name)
                      ? t('instances.downloaded')
                      : t('instances.downloadBundle')}
                </button>
                <span className="shrink-0 text-[11px]" style={{ color: 'var(--accent)' }}>
                  {t('instances.bundleDetails')} →
                </span>
              </div>
            </div>
            )
          })}
        </div>
        {bundleError && (
          <div className="mt-2 flex items-start justify-between gap-2 text-[12px]" style={{ color: 'var(--err)' }}>
            <p className="select-text break-all">{bundleError}</p>
            <CopyButton text={bundleError} />
          </div>
        )}
        {bundleNote && bundleNote.length > 0 && (
          <div
            className="mt-2 select-text space-y-1 rounded-lg border px-3 py-2 text-[12px]"
            style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium">{t('instances.bundleWarningsTitle')}</div>
              <div className="flex shrink-0 items-center gap-2">
                {bundleFailed && bundleFailed.specs.length > 0 && bundleBusy === null && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void retryFailedPlugins(bundleFailed.bundle)}
                  >
                    {t('instances.bundleRetryFailed')}
                  </button>
                )}
                <CopyButton text={bundleNote.join('\n')} title={t('common.copyAll')} />
              </div>
            </div>
            {bundleNote.map((w, i) => (
              <p key={i} className="leading-relaxed">
                ⚠ {w}
              </p>
            ))}
          </div>
        )}
      </div>

      {editing && <EditInstanceModal inst={editing} onClose={() => setEditing(null)} />}
      {creating && <NewInstanceModal onClose={() => setCreating(false)} />}
      {viewing && (
        <BundleDetailModal
          bundle={viewing}
          busy={bundleBusy !== null}
          installed={installedNames.has(viewing.name)}
          onClose={() => setViewing(null)}
          onDownload={() => {
            // 重新下载(实例已存在,home 已固定):直接重跑安装,不选数据目录。
            if (installedNames.has(viewing.name)) {
              void downloadBundle(viewing)
            } else {
              // 首次下载:先弹数据目录确认。
              setHomePick(viewing)
            }
          }}
        />
      )}
      {homePick && (
        <BundleHomeModal
          bundle={homePick}
          onClose={() => setHomePick(null)}
          onDownload={(opts) => {
            const b = homePick
            setHomePick(null)
            void downloadBundle(b, opts)
          }}
        />
      )}
      {progressBundle && (
        <BundleProgressModal
          bundle={progressBundle}
          warnings={bundleNote ?? []}
          failedSpecs={bundleFailed?.specs ?? []}
          onRetry={() => {
            if (bundleFailed) void retryFailedPlugins(bundleFailed.bundle)
          }}
          onClose={() => setProgressBundle(null)}
        />
      )}
      {qa === 'bundle' && (
        <QaModal
          title={t('instances.qaBundleTitle')}
          onClose={() => setQa(null)}
          qa={[
            { q: t('instances.qaBundle.1.q'), a: t('instances.qaBundle.1.a') },
            { q: t('instances.qaBundle.2.q'), a: t('instances.qaBundle.2.a') },
            { q: t('instances.qaBundle.3.q'), a: t('instances.qaBundle.3.a') },
            { q: t('instances.qaBundle.4.q'), a: t('instances.qaBundle.4.a') },
            { q: t('instances.qaBundle.5.q'), a: t('instances.qaBundle.5.a') },
            { q: t('instances.qaBundle.6.q'), a: t('instances.qaBundle.6.a') }
          ]}
        />
      )}
      {qa === 'instance' && (
        <QaModal
          title={t('instances.qaInstanceTitle')}
          onClose={() => setQa(null)}
          qa={[
            { q: t('instances.qaInstance.1.q'), a: t('instances.qaInstance.1.a') },
            { q: t('instances.qaInstance.2.q'), a: t('instances.qaInstance.2.a') },
            { q: t('instances.qaInstance.3.q'), a: t('instances.qaInstance.3.a') },
            { q: t('instances.qaInstance.4.q'), a: t('instances.qaInstance.4.a') },
            { q: t('instances.qaInstance.5.q'), a: t('instances.qaInstance.5.a') }
          ]}
        />
      )}
    </div>
  )
}
