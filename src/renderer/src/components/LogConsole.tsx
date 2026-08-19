import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLine } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { CopyButton } from './CopyButton'

const ERROR_RE = /error|failed|exception|ELIFECYCLE|Cannot find|ERR_MODULE|at \w+ \(/i
const LAUNCHER_RE = /^\[launcher\]/

function lineColor(l: LogLine): string {
  if (LAUNCHER_RE.test(l.line)) return 'var(--accent)'
  if (l.stream === 'stderr') return 'var(--warn)'
  if (ERROR_RE.test(l.line)) return 'var(--err)'
  return '#c3cad4'
}

/** Per-instance tag colors, cycled by sidebar order so every console is readable at a glance. */
const INSTANCE_COLORS = ['var(--accent)', '#e2c08d', '#8ab4f8', '#9ccc65', '#ce93d8', '#ffb74d', '#80cbc4', '#f48fb1']

interface MergedLine extends LogLine {
  instanceId: string
  instanceName: string
  tagColor: string
}

export function LogConsole({ height = '520px' }: { height?: string }): React.JSX.Element {
  const { t } = useI18n()
  // One unified console for every instance, instead of one per instance: merge
  // all buffers in time order and tag each line with its instance's name.
  const { logs, instances } = useHarness()
  const lines = useMemo<MergedLine[]>(() => {
    const out: MergedLine[] = []
    instances.forEach((inst, i) => {
      const tagColor = INSTANCE_COLORS[i % INSTANCE_COLORS.length]
      for (const l of logs[inst.id] ?? []) {
        out.push({ ...l, instanceId: inst.id, instanceName: inst.name, tagColor })
      }
    })
    out.sort((a, b) => a.at - b.at)
    return out
  }, [logs, instances])

  const ref = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [stick, setStick] = useState(true)
  const [clearedAt, setClearedAt] = useState(0)

  useEffect(() => {
    if (stickRef.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines, clearedAt])

  const onScroll = (): void => {
    const el = ref.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setStick(stickRef.current)
  }

  return (
    <div className="card overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-2.5 border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
      >
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full" style={{ background: '#ff5f57' }} />
          <span className="w-3 h-3 rounded-full" style={{ background: '#febc2e' }} />
          <span className="w-3 h-3 rounded-full" style={{ background: '#28c840' }} />
        </div>
        <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>
          {t('log.title')}
          {instances.length > 1 && <span className="ml-1.5">· {instances.length}</span>}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <CopyButton text={lines.map((l) => `[${l.instanceName}] ${l.line}`).join('\n')} title={t('common.copyAll')} />
          <button className="btn btn-ghost btn-sm" onClick={() => { setClearedAt(Date.now()) }}>
            {t('log.clear')}
          </button>
          <button
            className={`btn btn-sm ${stick ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => {
              stickRef.current = true
              setStick(true)
              if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
            }}
          >
            {stick ? t('log.autoScrollOn') : t('log.autoScroll')}
          </button>
        </div>
      </div>
      <div
        ref={ref}
        onScroll={onScroll}
        className="log-console select-text overflow-auto p-3"
        style={{ height, background: '#0b0d10' }}
      >
        {lines.length === 0 ? (
          <div className="mono text-[12.5px] leading-relaxed" style={{ color: '#5c6370' }}>
            {t('log.empty')}
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={`${clearedAt}-${i}`} className="mono text-[12.5px] leading-[1.55] whitespace-pre-wrap break-all">
              <span className="mr-2 select-none" style={{ color: l.tagColor }}>
                [{l.instanceName}]
              </span>
              <span style={{ color: lineColor(l) }}>{l.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
