import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { MoonIcon, SunIcon } from '../lib/icons'

const KEY = 'dsh-launcher-theme'

export function TopBar({ title }: { title: string }): JSX.Element {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
    return (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'dark'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(KEY, theme)
  }, [theme])

  return (
    <header
      className="h-[58px] flex items-center px-5 border-b"
      style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
    >
      <h1 className="text-[15px] font-semibold">{title}</h1>
      <div className="ml-auto flex items-center gap-2">
        <button
          className="btn btn-ghost btn-sm !p-2"
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  )
}
