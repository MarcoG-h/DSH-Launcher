import type { JSX } from 'react'
import { useHarness } from '../hooks/useHarness'
import { TerminalIcon, PuzzleIcon, GearIcon } from '../lib/icons'
import { StatusPill } from './StatusPill'

export type PageId = 'dashboard' | 'plugins' | 'settings'

const ITEMS: { id: PageId; label: string; icon: JSX.Element }[] = [
  { id: 'dashboard', label: '控制台', icon: <TerminalIcon /> },
  { id: 'plugins', label: '插件', icon: <PuzzleIcon /> },
  { id: 'settings', label: '设置', icon: <GearIcon /> }
]

export function Sidebar({ page, setPage }: { page: PageId; setPage: (p: PageId) => void }): JSX.Element {
  const { state, config, runningTasks } = useHarness()

  return (
    <aside className="w-[212px] shrink-0 flex flex-col border-r" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 h-[58px]">
        <div
          className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white font-bold text-[15px]"
          style={{ background: 'linear-gradient(135deg,#1783ff,#0b5ed7)' }}
        >
          D
        </div>
        <div>
          <div className="text-[14px] font-semibold leading-tight">DSH Launcher</div>
          <div className="text-[11px] leading-tight" style={{ color: 'var(--muted)' }}>
            DeepSeek Harness
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-2 space-y-1">
        {ITEMS.map((item) => {
          const active = page === item.id
          return (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[13px] font-medium transition-colors"
              style={{
                color: active ? 'var(--accent)' : 'var(--text)',
                background: active ? 'var(--accent-soft)' : 'transparent'
              }}
            >
              <span style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}>{item.icon}</span>
              {item.label}
            </button>
          )
        })}
      </nav>

      {/* Footer status */}
      <div className="px-4 py-3 border-t space-y-1.5" style={{ borderColor: 'var(--border)' }}>
        {runningTasks.length > 0 && (
          <div className="text-[11px] mono" style={{ color: 'var(--accent)' }}>
            ⚙ {runningTasks.length} 个任务进行中…
          </div>
        )}
        <div className="flex items-center gap-2">
          <StatusPill status={state?.status} />
        </div>
        <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
          profile: <span className="mono">{config?.profile ?? 'web'}</span> · 端口 {config?.port ?? 3080}
        </div>
      </div>
    </aside>
  )
}
