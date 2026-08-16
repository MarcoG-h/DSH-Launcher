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
import whaleIcon from '../assets/whale.png'

export type PageId = 'dashboard' | 'plugins' | 'settings'

interface SidebarProps {
  view: PageId | 'dsh'
  setView: (v: PageId | 'dsh') => void
  collapsed: boolean
  setCollapsed: (b: boolean) => void
  /** Current rail width (0 when the floating orb hides it entirely). */
  width: number
}

export function Sidebar({ view, setView, collapsed, setCollapsed, width }: SidebarProps): JSX.Element {
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

  // Inside the DSH view with the rail collapsed, the whole menu tucks onto the
  // whale: only the whale shows, and clicking it expands the menu again.
  const dshRail = view === 'dsh' && collapsed
  const hidden = width <= 0

  return (
    <aside
      className="shrink-0 flex flex-col border-r overflow-hidden transition-[width] duration-150"
      style={{
        width,
        borderColor: hidden ? 'transparent' : 'var(--border)',
        background: 'var(--panel)',
        // easeOutCubic — must match the DSH view animation in App.tsx so the
        // native view slides in step with the rail.
        transitionTimingFunction: 'cubic-bezier(0.215, 0.61, 0.355, 1)'
      }}
    >
      {/* Logo — the whale is the handle: click it to expand the collapsed DSH rail / collapse when open.
          The whale stays put (left-aligned) in both states so collapsing/expanding never makes it jump. */}
      <div className="flex items-center h-[58px] overflow-hidden shrink-0 gap-2.5 px-3.5">
        <button
          className="w-8 h-8 rounded-[10px] flex items-center justify-center overflow-hidden shrink-0 cursor-pointer select-none"
          style={{ background: '#fff', border: '1px solid rgba(128,128,128,0.25)' }}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          onClick={() => setCollapsed(!collapsed)}
        >
          <img src={whaleIcon} alt="" className="w-7 h-7 object-contain" draggable={false} />
        </button>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-[14px] font-semibold leading-tight truncate">DSH Launcher</div>
            <div className="text-[11px] leading-tight" style={{ color: 'var(--muted)' }}>
              DeepSeek Harness
            </div>
          </div>
        )}
      </div>

      {/* Nav — icon-only thumbnails when the DSH rail is collapsed; clicking a
          thumbnail expands the menu and jumps to that page. */}
      <nav className="flex-1 px-2.5 py-2 space-y-1 overflow-y-auto">
        {items.map((item) => {
          const active = view === item.id
          return (
            <button
              key={item.id}
              disabled={item.disabled}
              onClick={() => {
                if (dshRail) setCollapsed(false)
                // From the collapsed DSH rail the current view is already 'dsh';
                // the 'dsh' item only needs to expand — re-routing through the
                // App-level setView wrapper would force-collapse the rail again.
                if (dshRail && item.id === 'dsh') return
                setView(item.id)
              }}
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

      {/* Footer — hidden in the DSH rail */}
      {!dshRail && (
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
      )}
    </aside>
  )
}
