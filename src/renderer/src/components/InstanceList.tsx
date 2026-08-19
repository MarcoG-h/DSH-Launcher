import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { api, type DshInstance } from '../lib/api'
import { PlayIcon, StopIcon, RefreshIcon, ExternalIcon } from '../lib/icons'
import { StatusPill } from './StatusPill'
import { CopyButton } from './CopyButton'

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

/** One instance row: status + profile/port/uptime + icon-only start/restart/open-WebUI controls. */
function InstanceRow({
  inst,
  now,
  busy,
  onAction,
  onSelect
}: {
  inst: DshInstance
  now: number
  busy: boolean
  onAction: (inst: DshInstance, action: 'start' | 'stop' | 'restart') => Promise<void>
  onSelect: () => void
}): JSX.Element {
  const { t, statusLabel } = useI18n()
  const { states } = useHarness()
  const s = states[inst.id]
  const st = s?.status ?? 'stopped'
  const running = st !== 'stopped' && st !== 'error'
  const canRestart = st === 'running' || st === 'external'
  const uptime = s?.startedAt ? fmtUptime(Math.max(0, now - s.startedAt)) : null
  const port = s && s.port > 0 ? s.port : inst.port

  return (
    <div className="flex items-center gap-3 py-2">
      <button
        onClick={onSelect}
        title={statusLabel(st)}
        className="min-w-0 flex-1 text-left cursor-pointer select-none"
      >
        <div className="flex items-center gap-2">
          <StatusPill status={st} />
          <span className="truncate text-[13px] font-medium">{inst.name}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 pl-2 text-[11.5px]" style={{ color: 'var(--muted)' }}>
          <span>profile <span className="mono">{inst.profile}</span></span>
          <span>·</span>
          <span>{t('log.port', { port: port > 0 ? String(port) : '—' })}</span>
          {uptime !== null && (
            <>
              <span>·</span>
              <span>{t('instances.uptime', { uptime })}</span>
            </>
          )}
        </div>
        {s?.lastError && (
          <div className="mt-0.5 select-text pl-2 text-[12px]" style={{ color: 'var(--err)' }}>
            {t('dashboard.lastError')} {s.lastError}
          </div>
        )}
        {st === 'external' && (
          <div className="mt-0.5 select-text pl-2 text-[12px]" style={{ color: 'var(--warn)' }}>
            {t('dashboard.externalNotice')}
          </div>
        )}
      </button>

      <div className="flex items-center gap-1 shrink-0">
        {!running ? (
          <button
            className="btn btn-plain btn-sm !p-1"
            disabled={busy}
            title={t('dashboard.start')}
            onClick={() => void onAction(inst, 'start')}
          >
            <PlayIcon />
          </button>
        ) : (
          <button
            className="btn btn-danger btn-sm !p-1"
            disabled={busy}
            title={st === 'external' ? t('dashboard.stopExternal') : t('dashboard.stop')}
            onClick={() => void onAction(inst, 'stop')}
          >
            <StopIcon />
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm !p-1"
          disabled={busy || !canRestart}
          title={t('dashboard.restart')}
          onClick={() => void onAction(inst, 'restart')}
        >
          <RefreshIcon />
        </button>
        <button
          className="btn btn-ghost btn-sm !p-1"
          disabled={busy || !canRestart}
          title={`http://127.0.0.1:${port}`}
          onClick={() => void api.openUi(inst.id)}
        >
          <ExternalIcon />
        </button>
      </div>
    </div>
  )
}

/** The status hero turned into a list: every instance's state + controls on one page, in one panel. */
export function InstanceList(): JSX.Element {
  const { t } = useI18n()
  const { instances, states, setActiveInstance } = useHarness()
  // Hidden instances stay out of the status list — manage them from the Instances page.
  const visible = instances.filter(i => i.enabled !== false)
  const [busy, setBusy] = useState<{ id: string; action: 'start' | 'stop' | 'restart' } | null>(null)
  const [batchBusy, setBatchBusy] = useState<'start' | 'restart' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const act = async (inst: DshInstance, action: 'start' | 'stop' | 'restart'): Promise<void> => {
    setBusy({ id: inst.id, action })
    try {
      if (action === 'start') {
        const r = await api.startInstance(inst.id)
        if (!r.ok && r.error) setError(r.error)
      } else if (action === 'stop') {
        await api.stopInstance(inst.id)
      } else {
        const r = await api.restartInstance(inst.id)
        if (!r.ok && r.error) setError(r.error)
      }
    } finally {
      setBusy(null)
    }
  }

  const startAll = async (): Promise<void> => {
    setBatchBusy('start')
    const errs: string[] = []
    for (const inst of visible) {
      const st = states[inst.id]?.status
      if (st !== 'stopped' && st !== 'error') continue
      const r = await api.startInstance(inst.id)
      if (!r.ok && r.error) errs.push(r.error)
    }
    if (errs.length) setError(errs.join('; '))
    setBatchBusy(null)
  }

  const restartAll = async (): Promise<void> => {
    setBatchBusy('restart')
    const errs: string[] = []
    for (const inst of visible) {
      const r = await api.restartInstance(inst.id)
      if (!r.ok && r.error) errs.push(r.error)
    }
    if (errs.length) setError(errs.join('; '))
    setBatchBusy(null)
  }

  const anyBusy = busy !== null || batchBusy !== null

  // Overall health light: green when every started instance is fine, yellow when
  // any started instance needs attention (error / external), muted when all stopped.
  const overall = useMemo(() => {
    let active = 0
    let problem = false
    for (const inst of visible) {
      const st = states[inst.id]?.status ?? 'stopped'
      if (st === 'stopped') continue
      active++
      if (st === 'error' || st === 'external') problem = true
    }
    if (active === 0) return { color: 'var(--muted)', title: t('instances.allStopped') }
    if (problem) return { color: 'var(--warn)', title: t('instances.needAttention') }
    return { color: 'var(--ok)', title: t('instances.allOk') }
  }, [visible, states, t])

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-1">
        <div className="space-y-0.5">
          <h2 className="text-[22px] font-semibold flex items-center gap-2">
            DeepSeek Harness
            <span
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: overall.color }}
              title={overall.title}
            />
          </h2>
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            {t('instances.count', { count: visible.length })}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="btn btn-ghost btn-sm"
            disabled={batchBusy !== null || visible.length === 0}
            onClick={() => void startAll()}
          >
            <PlayIcon /> {t('instances.startAll')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={batchBusy !== null || visible.length === 0}
            onClick={() => void restartAll()}
          >
            <RefreshIcon /> {t('instances.restartAll')}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[12.5px]"
          style={{
            borderColor: 'var(--err)',
            color: 'var(--err)',
            background: 'color-mix(in srgb, var(--err) 8%, transparent)'
          }}
        >
          <span className="select-text break-all">{error}</span>
          <span className="flex shrink-0 items-center gap-2">
            <CopyButton text={error} />
            <button onClick={() => setError(null)} className="text-[12px] opacity-70 hover:opacity-100">
              ✕
            </button>
          </span>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="text-[13px]" style={{ color: 'var(--muted)' }}>
          {t('log.empty')}
        </div>
      ) : (
        <div className="divide-y" style={{ borderColor: 'color-mix(in srgb, var(--border) 14%, transparent)' }}>
          {visible.map((inst) => (
            <InstanceRow
              key={inst.id}
              inst={inst}
              now={now}
              busy={anyBusy}
              onAction={act}
              onSelect={() => void setActiveInstance(inst.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
