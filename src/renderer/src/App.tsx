import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { HarnessProvider, useHarness } from './hooks/useHarness'
import { I18nProvider, useI18n } from './i18n'
import { api } from './lib/api'
import { Sidebar, type PageId } from './components/Sidebar'
import { SplashOverlay } from './components/SplashOverlay'
import { TopBar } from './components/TopBar'
import { Dashboard } from './pages/Dashboard'
import { Instances } from './pages/Instances'
import { Plugins } from './pages/Plugins'
import { Settings } from './pages/Settings'

const SIDEBAR_EXPANDED = 212
const SIDEBAR_COLLAPSED = 56

function Shell(): JSX.Element {
  const { state, states, config, activeInstanceId } = useHarness()
  const { t } = useI18n()
  const TITLES: Record<PageId, string> = {
    dashboard: t('nav.dashboard'),
    instances: t('nav.instances'),
    plugins: t('nav.plugins'),
    settings: t('nav.settings')
  }
  const [view, setView] = useState<PageId | 'dsh'>('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  // The startup splash plays inside this window; the DSH view (a native child,
  // drawn above the DOM) stays hidden until the splash has finished.
  const [splashDone, setSplashDone] = useState(false)

  // The embedded DSH view may only open once the port actually reports ready —
  // not while 'starting'/'stopping' (a connection would just fail).
  const status = state?.status ?? 'stopped'
  const ready = status === 'running' || status === 'external'
  const inDsh = view === 'dsh'
  const splashActive = (config?.splashEnabled ?? true) && !splashDone
  const showDsh = ready && inDsh && !splashActive
  const prevReady = useRef<boolean | null>(null)
  // Set whenever the active instance transitions stopped→ready, i.e. a fresh
  // boot (first launch, a manual restart, or an auto-restart after a plugin
  // change). The dsh view must reload on such a transition — the cached page
  // from the previous run is stale. This is STATE, not a ref: the flag has to
  // survive until the view effect actually consumes it, which can be a later
  // render (the view isn't visible the moment the transition fires).
  const [reloadDsh, setReloadDsh] = useState(false)
  // Only the launcher's own launch auto-start (Settings → "Start DSH on
  // launch") may auto-jump into the DSH view. Consumed on the session's first
  // stopped→ready transition; the jump itself fires only if that transition was
  // the launch auto-start. Any later ready (manual start/restart, plugin
  // restart, instance switch) never jumps — the user navigates there.
  const autoJumpDone = useRef(false)

  // Auto-switch: once DSH becomes ready, open the embedded view and tuck the
  // launcher into the sidebar rail. When DSH stops, return to the dashboard.
  useEffect(() => {
    const was = prevReady.current
    prevReady.current = ready
    if (ready && !was) {
      setReloadDsh(true)
      if (!autoJumpDone.current) {
        autoJumpDone.current = true
        if (config?.autoStartOnLaunch) {
          setView('dsh')
          setCollapsed(true)
        }
      }
    } else if (!ready && inDsh) {
      setView('dashboard')
    }
  }, [ready, inDsh, config?.autoStartOnLaunch])

  // Show/hide the native DSH view for the active instance. On a stopped→ready
  // transition (or when the active instance changes to one that was booted
  // since this launcher run) we force a reload so a stale page from a previous
  // run isn't shown; otherwise that instance's cached view is shown (no
  // reload — the page keeps whatever the user had open).
  useEffect(() => {
    if (!activeInstanceId) return
    api.setDshActive(activeInstanceId, showDsh, showDsh && reloadDsh)
    if (showDsh && reloadDsh) setReloadDsh(false)
  }, [showDsh, activeInstanceId, reloadDsh])

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

  // Popped-out instances (running in a launcher child window) toggle back to the
  // embedded "integrated" view when their separate window closes — by the button
  // or by clicking the window's own close button. Popping an instance OUT leaves
  // the embedded DSH view (it would just duplicate the new window); closing it
  // brings the view back, but only for the active instance that is still up.
  const activeRef = useRef(activeInstanceId)
  activeRef.current = activeInstanceId
  const statesRef = useRef(states)
  statesRef.current = states
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    return api.onEvent((e) => {
      if (e.type !== 'popup') return
      const id = e.instanceId
      if (e.open) {
        if (id === activeRef.current && viewRef.current === 'dsh') {
          setView('dashboard')
          setCollapsed(false)
        }
      } else {
        const st = statesRef.current[id]
        if (id === activeRef.current && (st?.status === 'running' || st?.status === 'external')) {
          setView('dsh')
          setCollapsed(true)
        }
      }
    })
  }, [])

  const page = view === 'dsh' ? 'dashboard' : (view as PageId)

  return (
    <div className="flex h-full">
      {(config?.splashEnabled ?? true) && !splashDone && <SplashOverlay onDone={() => setSplashDone(true)} />}
      {/* Always mounted (width animates to 0 in orb mode) so the rail's content
          can't pop in/out; overflow-hidden on the rail clips it at width 0. */}
      <Sidebar
        view={inDsh ? 'dsh' : page}
        setView={(v) => {
          // Collapse the rail only when actually ENTERING the DSH view from
          // elsewhere (startup, a nav click, a jump from a non-DSH page).
          // Switching between two instances keeps the current rail state: the
          // view is already 'dsh', and re-collapsing on every switch makes the
          // sidebar useless when hopping between instances.
          if (v === 'dsh' && v !== view) setCollapsed(true)
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
          ) : page === 'instances' ? (
            <Instances />
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
