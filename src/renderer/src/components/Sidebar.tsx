import type { JSX } from 'react'
import { useHarness } from '../hooks/useHarness'
import { useTheme } from '../hooks/useTheme'
import { useI18n } from '../i18n'
import {
  TerminalIcon,
  PuzzleIcon,
  GearIcon,
  PanelIcon,
  ChevronIcon,
  SunIcon,
  MoonIcon
} from '../lib/icons'
import { StatusPill } from './StatusPill'

export type PageId = 'dashboard' | 'plugins' | 'settings'

interface SidebarProps {
  view: PageId | 'dsh'
  setView: (v: PageId | 'dsh') => void
  collapsed: boolean
  setCollapsed: (b: boolean) => void
}

export function Sidebar({ view, setView, collapsed, setCollapsed }: SidebarProps): JSX.Element {
  const { state, config, runningTasks } = useHarness()
  const [theme, toggleTheme] = useTheme()
  const { lang, t, setLang } = useI18n()

  // The DSH view is only reachable once the port is actually ready. The status
  // dot only shows when something is wrong — red for a harness error, yellow
  // for an externally running instance. Start/stop live on the dashboard.
  const status = state?.status ?? 'stopped'
  const ready = status === 'running' || status === 'external'
  const showStatus = status === 'error' || status === 'external'

  const items: { id: PageId | 'dsh'; label: string; icon: JSX.Element; disabled?: boolean }[] = [
    { id: 'dsh', label: t('nav.dsh'), icon: <PanelIcon />, disabled: !ready },
    { id: 'dashboard', label: t('nav.dashboard'), icon: <TerminalIcon /> },
    { id: 'plugins', label: t('nav.plugins'), icon: <PuzzleIcon /> },
    { id: 'settings', label: t('nav.settings'), icon: <GearIcon /> }
  ]

  const width = collapsed ? 56 : 212

  return (
    <aside
      className="shrink-0 flex flex-col border-r transition-[width] duration-150"
      style={{ width, borderColor: 'var(--border)', background: 'var(--panel)' }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-3.5 h-[58px] overflow-hidden shrink-0">
        <div
          className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white font-bold text-[15px] shrink-0"
          style={{ background: 'linear-gradient(135deg,#1783ff,#0b5ed7)' }}
        >
          D
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-[14px] font-semibold leading-tight truncate">DSH Launcher</div>
            <div className="text-[11px] leading-tight" style={{ color: 'var(--muted)' }}>
              DeepSeek Harness
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2.5 py-2 space-y-1 overflow-y-auto">
        {items.map((item) => {
          const active = view === item.id
          return (
            <button
              key={item.id}
              disabled={item.disabled}
              onClick={() => setView(item.id)}
              title={collapsed ? item.label : undefined}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                color: active ? 'var(--accent)' : 'var(--text)',
                background: active ? 'var(--accent-soft)' : 'transparent',
                justifyContent: collapsed ? 'center' : 'flex-start',
                paddingLeft: collapsed ? 0 : 12,
                paddingRight: collapsed ? 0 : 12
              }}
            >
              <span style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}>{item.icon}</span>
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t space-y-2 shrink-0" style={{ borderColor: 'var(--border)' }}>
        {runningTasks.length > 0 && (
          <div
            className="text-[11px] mono text-center"
            style={{ color: 'var(--accent)' }}
            title={t('sidebar.tasksRunning', { count: runningTasks.length })}
          >
            ⚙{runningTasks.length}
          </div>
        )}
        {showStatus && (
          <div className="flex items-center justify-center">
            <StatusPill status={state?.status} compact={collapsed} />
          </div>
        )}
        <div className={`flex items-center justify-center gap-1 pt-0.5 ${collapsed ? 'flex-col' : ''}`}>
          <button className="btn btn-ghost btn-sm !p-1.5" title={theme === 'dark' ? t('sidebar.switchLight') : t('sidebar.switchDark')} onClick={toggleTheme}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            className="btn btn-ghost btn-sm !p-1.5"
            title={t('sidebar.switchLang')}
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          >
            {lang === 'zh' ? 'EN' : '中'}
          </button>
          <button
            className="btn btn-ghost btn-sm !p-1.5"
            title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            onClick={() => setCollapsed(!collapsed)}
          >
            <ChevronIcon dir={collapsed ? 'right' : 'left'} />
          </button>
        </div>
        {!collapsed && (
          <div className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>
            profile <span className="mono">{config?.profile ?? 'web'}</span> {t('sidebar.portLabel')} {config?.port ?? 3080}
          </div>
        )}
      </div>
    </aside>
  )
}
