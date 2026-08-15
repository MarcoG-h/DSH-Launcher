import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { HarnessProvider, useHarness } from './hooks/useHarness'
import { api } from './lib/api'
import { Sidebar, type PageId } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Dashboard } from './pages/Dashboard'
import { Plugins } from './pages/Plugins'
import { Settings } from './pages/Settings'

const TITLES: Record<PageId, string> = {
  dashboard: '控制台',
  plugins: '第三方插件管理',
  settings: '设置'
}

const SIDEBAR_EXPANDED = 212
const SIDEBAR_COLLAPSED = 56

function Shell(): JSX.Element {
  const { state } = useHarness()
  const [view, setView] = useState<PageId | 'dsh'>('dashboard')
  const [collapsed, setCollapsed] = useState(false)

  // The embedded DSH view may only open once the port actually reports ready —
  // not while 'starting'/'stopping' (a connection would just fail).
  const status = state?.status ?? 'stopped'
  const ready = status === 'running' || status === 'external'
  const inDsh = view === 'dsh'
  const showDsh = ready && inDsh
  const prevReady = useRef<boolean | null>(null)
  const freshReady = useRef(false)

  // Auto-switch: once DSH becomes ready, open the embedded view and tuck the
  // launcher into the sidebar rail. When DSH stops, return to the dashboard.
  useEffect(() => {
    const was = prevReady.current
    prevReady.current = ready
    freshReady.current = ready && !was
    if (ready && !was) {
      setView('dsh')
      setCollapsed(true)
    } else if (!ready && inDsh) {
      setView('dashboard')
    }
  }, [ready, inDsh])

  // Show/hide the native DSH view. On a fresh ready transition we force a
  // reload so a stale page from a previous run isn't shown.
  useEffect(() => {
    api.setDshActive(showDsh, showDsh && freshReady.current)
  }, [showDsh])

  // Keep the view flush against the sidebar rail when it expands/collapses.
  useEffect(() => {
    api.setDshSidebarWidth(collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED)
  }, [collapsed])

  const page = view === 'dsh' ? 'dashboard' : (view as PageId)

  return (
    <div className="flex h-full">
      <Sidebar
        view={inDsh ? 'dsh' : page}
        setView={(v) => {
          if (v === 'dsh') setCollapsed(true)
          setView(v)
        }}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
      />
      <div className="flex-1 flex flex-col min-w-0">
        {!inDsh && <TopBar title={TITLES[page]} />}
        <main className={`flex-1 ${inDsh ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {inDsh ? null : page === 'dashboard' ? (
            <Dashboard />
          ) : page === 'plugins' ? (
            <Plugins />
          ) : (
            <Settings />
          )}
        </main>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <HarnessProvider>
      <Shell />
    </HarnessProvider>
  )
}
