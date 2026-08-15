import type { JSX } from 'react'

export function TopBar({ title }: { title: string }): JSX.Element {
  return (
    <header
      className="h-[58px] flex items-center px-5 border-b shrink-0"
      style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
    >
      <h1 className="text-[15px] font-semibold">{title}</h1>
    </header>
  )
}
