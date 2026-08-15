import { useEffect, useRef, useState } from 'react'
import type { LogLine } from '../lib/api'
import { useI18n } from '../i18n'

const ERROR_RE = /error|failed|exception|ELIFECYCLE|Cannot find|ERR_MODULE|at \w+ \(/i
const LAUNCHER_RE = /^\[launcher\]/

function lineColor(l: LogLine): string {
  if (LAUNCHER_RE.test(l.line)) return 'var(--accent)'
  if (l.stream === 'stderr') return 'var(--warn)'
  if (ERROR_RE.test(l.line)) return 'var(--err)'
  return '#c3cad4'
}

export function LogConsole({ lines, height = '520px' }: { lines: LogLine[]; height?: string }): React.JSX.Element {
  const { t } = useI18n()
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
        </span>
        <div className="ml-auto flex items-center gap-2">
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
        className="log-console overflow-auto p-3"
        style={{ height, background: '#0b0d10' }}
      >
        {lines.length === 0 ? (
          <div className="mono text-[12.5px] leading-relaxed" style={{ color: '#5c6370' }}>
            {t('log.empty')}
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={`${clearedAt}-${i}`} className="mono text-[12.5px] leading-[1.55] whitespace-pre-wrap break-all" style={{ color: lineColor(l) }}>
              {l.line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
