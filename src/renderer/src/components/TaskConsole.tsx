import { useEffect, useRef, useState } from 'react'
import type { TaskLog } from '../lib/api'
import { formatDuration, useI18n } from '../i18n'
import { CopyButton } from './CopyButton'

function lineColor(stream: string, line: string): string {
  if (/error|failed|ELIFECYCLE|Cannot find|ERR_MODULE/i.test(line)) return 'var(--err)'
  if (stream === 'stderr') return 'var(--warn)'
  return '#c3cad4'
}

/** Determinate bar when progress is known; animated when the step is running but indeterminate. */
function ProgressBar({ progress, running }: { progress: number | null; running: boolean }): React.JSX.Element {
  const pct = progress != null ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null
  return (
    <div
      className="h-[5px] w-full overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}
    >
      {pct != null ? (
        <div
          className="h-full transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%`, background: 'var(--accent)' }}
        />
      ) : running ? (
        <div className="h-full progress-indeterminate" />
      ) : null}
    </div>
  )
}

export function TaskConsole({ task }: { task: TaskLog }): React.JSX.Element {
  const { lang, t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [task.lines])

  // Live elapsed counter while the task runs, so a long step shows it's alive.
  useEffect(() => {
    if (!task.running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [task.running])

  const elapsed = task.running ? Math.max(0, now - task.startedAt) : 0

  return (
    <div
      className="rounded-lg overflow-hidden border"
      style={{ borderColor: 'var(--border)', background: '#0b0d10' }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <span className="w-2 h-2 rounded-full" style={{ background: task.running ? 'var(--accent)' : task.code === 0 ? 'var(--ok)' : 'var(--err)' }} />
        <span className="mono text-[12px] font-medium truncate" style={{ color: 'var(--muted)' }}>
          {task.label}
        </span>
        {task.phase && (
          <span className="text-[11px] truncate min-w-0" style={{ color: 'var(--muted)' }}>
            · {task.phase}
          </span>
        )}
        <span className="ml-auto text-[11px] shrink-0" style={{ color: 'var(--muted)' }}>
          {task.running
            ? `${t('task.running.pre')} ${formatDuration(elapsed, lang)}`
            : task.code === 0
              ? t('task.doneExit')
              : t('task.failedExit', { code: task.code ?? '?' })}
        </span>
        <CopyButton text={task.lines.map((l) => l.line).join('\n')} title={t('common.copyAll')} />
      </div>
      <ProgressBar progress={task.progress} running={task.running} />
      <div ref={ref} className="log-console select-text overflow-auto max-h-[220px] p-3">
        {task.lines.length === 0 ? (
          <div className="mono text-[12px]" style={{ color: '#5c6370' }}>
            {task.running ? t('task.waiting') : t('task.noOutput')}
          </div>
        ) : (
          task.lines.map((l, i) => (
            <div key={i} className="mono text-[12px] leading-[1.5] whitespace-pre-wrap break-all" style={{ color: lineColor(l.stream, l.line) }}>
              {l.line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
