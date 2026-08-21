import type { JSX } from 'react'
import { useHarness } from '../hooks/useHarness'
import { useTheme } from '../hooks/useTheme'
import { useI18n } from '../i18n'
import { api, type DshInstance } from '../lib/api'
import {
  TerminalIcon,
  ListIcon,
  PuzzleIcon,
  GearIcon,
  PanelIcon,
  ChevronIcon,
  PlusIcon,
  SunIcon,
  MoonIcon,
  PlayIcon,
  StopIcon,
  NewWindowIcon,
  WindowReturnIcon
} from '../lib/icons'
import { StatusPill } from './StatusPill'
import whaleIcon from '../assets/whale.png'

export type PageId = 'dashboard' | 'instances' | 'plugins' | 'settings'

interface SidebarProps {
  view: PageId | 'dsh'
  setView: (v: PageId | 'dsh') => void
  collapsed: boolean
  setCollapsed: (b: boolean) => void
  /** Current rail width (0 when the floating orb hides it entirely). */
  width: number
}

/** Status dot color per harness status (mirrors StatusPill). */
const STATUS_COLOR: Record<string, string> = {
  running: 'var(--ok)',
  starting: 'var(--accent)',
  stopping: 'var(--warn)',
  error: 'var(--err)',
  stopped: 'var(--muted)',
  external: 'var(--warn)'
}
const STATUS_PULSE: Record<string, boolean> = {
  starting: true,
  stopping: true
}

export function Sidebar({ view, setView, collapsed, setCollapsed, width }: SidebarProps): JSX.Element {
  const { state, config, runningTasks, instances, states, activeInstanceId, poppedOut, setActiveInstance, launcherUpdate } = useHarness()
  const [theme, toggleTheme] = useTheme()
  const { lang, t, setLang, statusLabel } = useI18n()
  // Hidden instances stay out of the sidebar — manage them from the Instances page.
  const visible = instances.filter(i => i.enabled !== false)

  // Clicking an instance row switches the active instance, and — when that
  // instance is up and not popped out — jumps straight to its DSH view (collapsing
  // the rail, like pressing the DSH nav item). No view switch when it's not ready
  // so we don't flash the dashboard back over the stopped instance.
  const onInstanceClick = async (inst: DshInstance): Promise<void> => {
    await setActiveInstance(inst.id)
    const st = states[inst.id]?.status ?? 'stopped'
    if ((st === 'running' || st === 'external') && !poppedOut[inst.id]) {
      setView('dsh')
    }
  }

  // The DSH view is only reachable once the active instance's port is ready.
  const status = state?.status ?? 'stopped'
  const ready = status === 'running' || status === 'external'
  const showStatus = status === 'error' || status === 'external'

  const items: { id: PageId | 'dsh'; label: string; icon: JSX.Element; disabled?: boolean }[] = [
    { id: 'dsh', label: t('nav.dsh'), icon: <PanelIcon />, disabled: !ready },
    { id: 'dashboard', label: t('nav.dashboard'), icon: <TerminalIcon /> },
    { id: 'instances', label: t('nav.instances'), icon: <ListIcon /> },
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

      {/* Instances — click to switch which dsh the dashboard/DSH view shows.
          Each row carries a status dot so you can watch every instance at once. */}
      {!dshRail && instances.length > 0 && (
        <div className={`shrink-0 ${collapsed ? 'px-2 py-1 space-y-1.5' : 'px-2.5 pb-1 space-y-0.5'}`}>
          {!collapsed && (
            <div className="flex items-center justify-between px-2 pt-0.5 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                {t('sidebar.instances')}
              </span>
              <button
                className="btn btn-ghost btn-sm !p-1"
                title={t('sidebar.addInstance')}
                onClick={() => setView('instances')}
              >
                <PlusIcon />
              </button>
            </div>
          )}
          <div className="space-y-0.5">
            {visible.map((inst) => {
              const st = states[inst.id]?.status ?? 'stopped'
              const pending = states[inst.id]?.pendingRestart === true
              const isActive = inst.id === activeInstanceId
              // A pending plugin change turns the dot yellow until the instance
              // is manually restarted (harness clears the flag when running).
              const color = pending ? 'var(--warn)' : (STATUS_COLOR[st] ?? STATUS_COLOR.stopped)
              const pulse = STATUS_PULSE[st] === true
              // Start/stop mirrors the Dashboard control: anything but a clean
              // idle/error shows stop (incl. starting/stopping/external).
              const canStop = st !== 'stopped' && st !== 'error'
              const canOpenUi = st === 'running' || st === 'external'
              // The instance toggles between running embedded in the launcher and
              // running in a separate (popped-out) child window.
              const popped = !!poppedOut[inst.id]
              return (
                <div
                  key={inst.id}
                  className="w-full flex items-center gap-1 rounded-lg"
                  style={{
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    background: isActive ? 'var(--accent-soft)' : 'transparent'
                  }}
                >
                  <button
                    onClick={() => void onInstanceClick(inst)}
                    title={`${inst.name} · ${statusLabel(st)}${pending ? ' · ' + t('sidebar.pendingRestart') : ''}`}
                    className="min-w-0 flex-1 flex items-center gap-2 rounded-lg cursor-pointer select-none"
                    style={{
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      padding: collapsed ? '6px' : '5px 8px',
                      color: isActive ? 'var(--accent)' : 'var(--text)'
                    }}
                  >
                    <span
                      className={`badge-dot shrink-0${pulse ? ' pulse-live' : ''}`}
                      style={{ background: color }}
                    />
                    {!collapsed && <span className="truncate text-[12px]">{inst.name}</span>}
                    {!collapsed && pending && (
                      <span
                        className="badge shrink-0 !px-1.5 text-[10px]"
                        style={{ color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 16%, transparent)' }}
                      >
                        {t('sidebar.pendingRestart')}
                      </span>
                    )}
                  </button>
                  {!collapsed && (
                    <>
                      {/* Toggle the selected, running instance between embedded
                          and a launcher child window (drag it to another monitor).
                          Only visible for the selected instance while running. */}
                      {isActive && canOpenUi && (
                        <button
                          className={`btn btn-sm !p-1 ${popped ? 'btn-primary' : 'btn-ghost'}`}
                          title={popped ? t('sidebar.returnIntegrated') : t('sidebar.openNewWindow')}
                          onClick={() => void (popped ? api.closeInstanceWindow(inst.id) : api.openInstanceWindow(inst.id))}
                        >
                          {popped ? <WindowReturnIcon /> : <NewWindowIcon />}
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-sm !p-1"
                        title={canStop ? t('sidebar.stop') : t('sidebar.start')}
                        onClick={() => void (canStop ? api.stopInstance(inst.id) : api.startInstance(inst.id))}
                      >
                        {canStop ? <StopIcon /> : <PlayIcon />}
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

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
        {/* 提示式更新:检测到 DSH-Launcher 新版本时提示,点击打开 GitHub Release 下载页 */}
        {launcherUpdate?.update && launcherUpdate.url && (
          <a
            href={launcherUpdate.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg px-3 py-2 text-[12px] font-medium leading-snug cursor-pointer select-none"
            style={{ color: 'var(--accent)', background: 'var(--accent-soft)', border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)' }}
            title={t('sidebar.launcherUpdateHint')}
          >
            ↑ {t('sidebar.launcherUpdate', { latest: launcherUpdate.latest ?? '' })}
          </a>
        )}
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
