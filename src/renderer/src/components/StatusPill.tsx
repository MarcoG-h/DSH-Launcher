import { statusLabel } from '../hooks/useHarness'

const STYLES: Record<string, { color: string; pulse: boolean }> = {
  running: { color: 'var(--ok)', pulse: false },
  starting: { color: 'var(--accent)', pulse: true },
  stopping: { color: 'var(--warn)', pulse: true },
  error: { color: 'var(--err)', pulse: false },
  stopped: { color: 'var(--muted)', pulse: false }
}

export function StatusPill({ status }: { status: string | undefined }): React.JSX.Element {
  const s = STYLES[status ?? 'stopped'] ?? STYLES.stopped
  return (
    <span
      className="badge"
      style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 14%, transparent)` }}
    >
      <span
        className={`badge-dot${s.pulse ? ' pulse-live' : ''}`}
        style={{ background: s.color }}
      />
      {statusLabel(status)}
    </span>
  )
}
