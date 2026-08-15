import { useI18n } from '../i18n'

const STYLES: Record<string, { color: string; pulse: boolean }> = {
  running: { color: 'var(--ok)', pulse: false },
  starting: { color: 'var(--accent)', pulse: true },
  stopping: { color: 'var(--warn)', pulse: true },
  error: { color: 'var(--err)', pulse: false },
  stopped: { color: 'var(--muted)', pulse: false },
  external: { color: 'var(--warn)', pulse: false }
}

export function StatusPill({ status, compact }: { status: string | undefined; compact?: boolean }): React.JSX.Element {
  const { statusLabel } = useI18n()
  const s = STYLES[status ?? 'stopped'] ?? STYLES.stopped
  return (
    <span
      className="badge"
      title={compact ? statusLabel(status) : undefined}
      style={{
        color: s.color,
        background: `color-mix(in srgb, ${s.color} 14%, transparent)`,
        padding: compact ? '3px 6px' : undefined
      }}
    >
      <span
        className={`badge-dot${s.pulse ? ' pulse-live' : ''}`}
        style={{ background: s.color }}
      />
      {!compact && statusLabel(status)}
    </span>
  )
}
