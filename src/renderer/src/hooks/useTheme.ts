import { useEffect, useState } from 'react'

const KEY = 'dsh-launcher-theme'

export type Theme = 'dark' | 'light'

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
    return (document.documentElement.dataset.theme as Theme) ?? 'dark'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(KEY, theme)
  }, [theme])

  const toggle = (): void => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  return [theme, toggle]
}
