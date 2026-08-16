// Minimal iOS-style toggle switch used in Settings rows (replaces checkboxes).
import type { JSX } from 'react'

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="shrink-0"
      style={{
        width: 36,
        height: 20,
        borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--border)',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background 0.15s ease',
        padding: 0,
        border: 'none',
        outlineOffset: 2
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: checked ? '#ffffff' : 'var(--bg-soft)',
          transition: 'left 0.15s ease, background 0.15s ease',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.35)'
        }}
      />
    </button>
  )
}
