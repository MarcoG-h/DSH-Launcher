import { useEffect, useRef } from 'react'
import type { TaskLog } from '../lib/api'

function lineColor(stream: string, line: string): string {
  if (/error|failed|ELIFECYCLE|Cannot find|ERR_MODULE/i.test(line)) return 'var(--err)'
  if (stream === 'stderr') return 'var(--warn)'
  return '#c3cad4'
}

export function TaskConsole({ task }: { task: TaskLog }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [task.lines])

  return (
    <div
      className="rounded-lg overflow-hidden border"
      style={{ borderColor: 'var(--border)', background: '#0b0d10' }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <span className="w-2 h-2 rounded-full" style={{ background: task.running ? 'var(--accent)' : task.code === 0 ? 'var(--ok)' : 'var(--err)' }} />
        <span className="mono text-[12px] font-medium" style={{ color: 'var(--muted)' }}>
          {task.label}
        </span>
        <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>
          {task.running ? '执行中…' : task.code === 0 ? '完成 (exit 0)' : `失败 (exit ${task.code ?? '?'})`}
        </span>
      </div>
      <div ref={ref} className="log-console overflow-auto max-h-[220px] p-3">
        {task.lines.length === 0 ? (
          <div className="mono text-[12px]" style={{ color: '#5c6370' }}>
            {task.running ? '等待输出…' : '无输出'}
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
