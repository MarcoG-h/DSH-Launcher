import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { HarnessProvider, useHarness } from './hooks/useHarness'
import { I18nProvider, useI18n } from './i18n'
import { api } from './lib/api'
import { Sidebar, type PageId } from './components/Sidebar'
import { SplashOverlay } from './components/SplashOverlay'
import { Dashboard } from './pages/Dashboard'
import { Instances } from './pages/Instances'
import { Plugins } from './pages/Plugins'
import { Security } from './pages/Security'
import { Settings } from './pages/Settings'

const SIDEBAR_EXPANDED = 212
const SIDEBAR_COLLAPSED = 56

function Shell(): JSX.Element {
  const { state, states, config, activeInstanceId } = useHarness()
  const [view, setView] = useState<PageId | 'dsh' | 'web'>('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  // The startup splash plays inside this window; the DSH view (a native child,
  // drawn above the DOM) stays hidden until the splash has finished.
  const [splashDone, setSplashDone] = useState(false)

  // The embedded DSH view may only open once the port actually reports ready —
  // not while 'starting'/'stopping' (a connection would just fail).
  const status = state?.status ?? 'stopped'
  const ready = status === 'running' || status === 'external'
  const inDsh = view === 'dsh'
  const inWeb = view === 'web'
  // 原生视图(DSH 或网页版)占据内容区时,DOM 不渲染页面。
  const inNative = inDsh || inWeb
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

  // 托盘「设置」菜单项:打开窗口并导航到设置页。
  useEffect(() => {
    return api.onEvent((e) => {
      if (e.type === 'launcher-page' && e.page === 'settings') setView('settings')
    })
  }, [])

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

  // 网页版免费对话(虚拟实例)是真正的视图('web',相当于 DSH 界面),不是浮层:
  // 点开自动缩侧边栏,和其他实例的 DSH 视图行为一致。每张卡在 main 侧有独立常驻视图,
  // 切走/离开再回来不重载(对话保留);双击侧栏卡 = 刷新(F5,带一次 forceReload)。
  const [webChatId, setWebChatId] = useState<string | null>(null)
  const [webReloadTick, setWebReloadTick] = useState(0)
  const webChat = (config?.webChats ?? []).find((w) => w.id === webChatId) ?? null

  // 打开一张网页卡:内嵌 = 切到该卡视图(不重载);popout = 独立窗口(不改视图)。
  const openWebChat = (wc: { id: string; url: string }, popout: boolean): void => {
    if (popout) api.setWebChat(true, wc.id, wc.url, true)
    else { setWebChatId(wc.id); setView('web') }
  }
  // 双击侧栏网页卡:先切到该卡(若未在),再让它刷新一次(相当于 F5)。普通单击仍只切换不重载。
  const refreshWebChat = (wc: { id: string; url: string }): void => {
    setWebChatId(wc.id)
    setView('web')
    setWebReloadTick((t) => t + 1)
  }
  // 统一的原生视图管理:网页聊天视图打开时隐藏 DSH 视图;否则恢复 DSH/页面。
  // 顺序很关键:先隐藏 DSH,再显示网页聊天(共享的 active 状态由最后一次调用定夺)。
  // forceReload 是一次性的:双击侧栏卡触发,消费后立刻清零,普通进出不重载。
  useEffect(() => {
    if (inWeb) {
      // 当前卡已被删(配置里找不到)→ 退出网页视图,别让空卡占着。
      if (!webChat) { setView('dashboard'); return }
      if (activeInstanceId) api.setDshActive(activeInstanceId, false)
      const force = webReloadTick > 0
      if (force) setWebReloadTick(0)
      api.setWebChat(true, webChat.id, webChat.url, false, force)
    } else {
      if (webChat) api.setWebChat(false, webChat.id, webChat.url, false)
      if (activeInstanceId) {
        api.setDshActive(activeInstanceId, showDsh, showDsh && reloadDsh)
        if (showDsh && reloadDsh) setReloadDsh(false)
      }
    }
  }, [inWeb, activeInstanceId, showDsh, reloadDsh, webChat, webReloadTick])

  // "floatingWhale" (Settings, default off) swaps the collapsed rail for a
  // draggable orb: the sidebar disappears and the native view (DSH 或网页版) fills
  // the window, with the orb floating on top。网页版视图同样适用。
  const floatingWhale = config?.floatingWhale ?? false
  const orbMode = floatingWhale && inNative && collapsed

  // Keep the view flush against the sidebar rail when it expands/collapses —
  // in orb mode the rail is gone, so the native view spans the full window.
  const dshWidth = orbMode ? 0 : collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED

  // 宽度变化直接把目标值发给主进程,由主进程做 150ms easing 动画(渲染层被内嵌 dsh
  // 遮挡时 rAF 会节流,不能再用渲染层驱动;主进程 setTimeout 不受影响)。初始挂载也走
  // 这里(from===to 时主进程直接 no-op)。
  useEffect(() => {
    api.setDshSidebarWidth(dshWidth)
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
        view={inNative ? (inDsh ? 'dsh' : 'web') : page}
        setView={(v) => {
          // 进入原生视图(DSH/网页版)时收侧边栏,但只在「从普通页面进入」时收。
          // 在原生视图之间切换(网页↔实例、实例↔实例)保持当前侧边栏状态,
          // 不重复收——和实例间切换的逻辑一致。
          if ((v === 'dsh' || v === 'web') && !inNative) setCollapsed(true)
          setView(v)
        }}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        width={dshWidth}
        onOpenWebChat={openWebChat}
        onRefreshWebChat={refreshWebChat}
        activeWebChatId={webChatId}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <main className={`flex-1 ${inNative ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {inNative ? null : page === 'dashboard' ? (
            <Dashboard />
          ) : page === 'instances' ? (
            <Instances onOpenWebChat={openWebChat} />
          ) : page === 'plugins' ? (
            <Plugins />
          ) : page === 'security' ? (
            <Security />
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
