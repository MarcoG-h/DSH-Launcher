import { useEffect, useState } from 'react'

export type ThemeMode = 'dark' | 'light'
export type ThemeStyle = 'glass' | 'flat'

const THEME_KEY = 'dsh-launcher-theme'
const STYLE_KEY = 'dsh-launcher-style'
const ACCENT_KEY = 'dsh-launcher-accent'
const BGM_KEY = 'dsh-launcher-bg'

/** 可选的预设主色(与 #1783ff 同亮度,深浅主题下都可用)。 */
export const ACCENT_PRESETS = [
  '#1783ff',
  '#0ea5e9',
  '#8b5cf6',
  '#ec4899',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#14b8a6'
]
export const DEFAULT_ACCENT = '#1783ff'

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

interface ThemeState {
  theme: ThemeMode
  style: ThemeStyle
  accent: string
  /** 用户上传的背景图(data URL,空串 = 无)。 */
  bgImage: string
}

function readInit(): ThemeState {
  const theme = localStorage.getItem(THEME_KEY)
  const style = localStorage.getItem(STYLE_KEY)
  const savedAccent = localStorage.getItem(ACCENT_KEY) ?? DEFAULT_ACCENT
  const bg = localStorage.getItem(BGM_KEY) ?? ''
  return {
    theme: theme === 'light' ? 'light' : 'dark',
    style: style === 'glass' ? 'glass' : 'flat',
    accent: /^#[0-9a-fA-F]{6}$/.test(savedAccent) ? savedAccent : DEFAULT_ACCENT,
    bgImage: /^data:image\/(jpeg|png);base64,/.test(bg) ? bg : ''
  }
}

// 模块级单例:所有消费组件共享同一份主题状态(主题/风格/主色)。
let state: ThemeState = readInit()
const listeners = new Set<() => void>()

function apply(): void {
  const root = document.documentElement
  root.dataset.theme = state.theme
  root.dataset.style = state.style
  // 主配色:--accent 由用户选择,派生的 soft/border 变体跟随主色(组件里也用了
  // color-mix,这里兜底设置确保 picker 一选就整体换色)。
  root.style.setProperty('--accent', state.accent)
  root.style.setProperty('--accent-soft', hexToRgba(state.accent, 0.14))
  root.style.setProperty('--accent-border', hexToRgba(state.accent, 0.45))
  // 背景图:直接设到 body 的 background-image,不走 --bg-image var() ——
  // 较大的 data URL 经 var() 代换进 background 时会被 Chromium 丢弃(几 MB 的
  // 原图因此显示不出来,预览用内联样式所以正常)。直接 CSSOM 注入没有这个限制。
  const body = document.body
  if (state.bgImage) {
    body.style.backgroundImage = `url(${state.bgImage})`
    body.style.backgroundSize = 'cover'
    body.style.backgroundPosition = 'center'
    body.style.backgroundRepeat = 'no-repeat'
    root.dataset.bgImage = 'set'
  } else {
    body.style.backgroundImage = ''
    body.style.backgroundSize = ''
    body.style.backgroundPosition = ''
    body.style.backgroundRepeat = ''
    root.dataset.bgImage = ''
  }
  try {
    localStorage.setItem(THEME_KEY, state.theme)
    localStorage.setItem(STYLE_KEY, state.style)
    localStorage.setItem(ACCENT_KEY, state.accent)
    if (state.bgImage) localStorage.setItem(BGM_KEY, state.bgImage)
    else localStorage.removeItem(BGM_KEY)
  } catch {
    /* 隐私模式等场景下 localStorage 不可写,忽略 */
  }
}

function patch(p: Partial<ThemeState>): void {
  state = { ...state, ...p }
  apply()
  for (const l of listeners) l()
}

export function useTheme() {
  const [, setTick] = useState(0)
  useEffect(() => {
    apply()
    const l = (): void => setTick((t) => t + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return {
    theme: state.theme,
    style: state.style,
    accent: state.accent,
    bgImage: state.bgImage,
    toggleTheme: (): void => patch({ theme: state.theme === 'dark' ? 'light' : 'dark' }),
    setStyle: (style: ThemeStyle): void => patch({ style }),
    setAccent: (accent: string): void => {
      if (/^#[0-9a-fA-F]{6}$/.test(accent)) patch({ accent })
    },
    setBgImage: (bgImage: string): void => {
      // 仅接受 data:image/jpeg 或 data:image/png;过大拒绝(避免撑爆 localStorage)。
      if (bgImage === '' || /^data:image\/(jpeg|png);base64,/.test(bgImage)) patch({ bgImage })
    }
  }
}
