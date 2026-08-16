import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { HarnessProvider, useHarness } from './hooks/useHarness'
import { I18nProvider, useI18n } from './i18n'
import { api } from './lib/api'
import { Sidebar, type PageId } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Dashboard } from './pages/Dashboard'
import { Plugins } from './pages/Plugins'
import { Settings } from './pages/Settings'

const SIDEBAR_EXPANDED = 212
const SIDEBAR_COLLAPSED = 56

function Shell(): JSX.Element {
  const { state, config } = useHarness()
  const { t } = useI18n()
  const TITLES: Record<PageId, string> = {
    dashboard: t('nav.dashboard'),
    plugins: t('nav.plugins'),
    settings: t('nav.settings')
  }
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

  // "floatingWhale" (Settings, default off) swaps the collapsed DSH rail for a
  // draggable orb: the sidebar disappears entirely and the DSH view fills the
  // window, with the orb floating on top.
  const floatingWhale = config?.floatingWhale ?? false
  const orbMode = floatingWhale && inDsh && collapsed

  // Keep the view flush against the sidebar rail when it expands/collapses —
  // in orb mode the rail is gone, so the DSH view spans the full window.
  const dshWidth = orbMode ? 0 : collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED

  // The sidebar's width transition is pure CSS; the DSH view is a native child
  // view so it can't transition — animate it with the same easing/duration here
  // so the embedded page slides in step with the rail instead of jumping.
  const widthAnim = useRef(dshWidth)
  useEffect(() => {
    const from = widthAnim.current
    const to = dshWidth
    widthAnim.current = to
    if (from === to) return
    const DUR = 150
    const t0 = performance.now()
    let raf = 0
    const step = (): void => {
      const p = Math.min(1, (performance.now() - t0) / DUR)
      const eased = 1 - Math.pow(1 - p, 3)
      api.setDshSidebarWidth(Math.round(from + (to - from) * eased))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [dshWidth])

  // Show the floating orb while the DSH view is open in orb mode.
  useEffect(() => {
    api.setOrbVisible(orbMode)
  }, [orbMode])

  // The orb's short click expands the menu (the orb itself already returned to
  // the top-left in the main process).
  useEffect(() => {
    return api.onOrbClicked(() => {
      setCollapsed(false)
    })
  }, [])

  const page = view === 'dsh' ? 'dashboard' : (view as PageId)

  return (
    <div className="flex h-full">
      {/* Always mounted (width animates to 0 in orb mode) so the rail's content
          can't pop in/out; overflow-hidden on the rail clips it at width 0. */}
      <Sidebar
        view={inDsh ? 'dsh' : page}
        setView={(v) => {
          if (v === 'dsh') setCollapsed(true)
          setView(v)
        }}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        width={dshWidth}
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
      <I18nProvider>
        <Shell />
      </I18nProvider>
    </HarnessProvider>
  )
}
