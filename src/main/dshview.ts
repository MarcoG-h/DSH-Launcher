// Hosts the DSH Web UI for each instance in a native WebContentsView, positioned
// flush against the right edge of the launcher sidebar. Only the active
// instance's view is visible at a time; the others stay alive (their page is
// cached), so switching instances never reloads a page the user already had open.
//
// The legacy <webview> tag routes the guest through the host renderer's DOM,
// which breaks IME composition and places the IME candidate window at the
// wrong coordinates. A WebContentsView is a first-class child of the window's
// content view, so keyboard focus and IME work natively.

import { BrowserWindow, shell, WebContentsView, type WebContents } from 'electron'
import { consumeInstanceAuthUrl, getInstanceAuthUrl, getState, onInstanceAuthUrl } from './harness'

const SIDEBAR_EXPANDED = 212
const SIDEBAR_COLLAPSED = 56

/** 虚拟实例(DeepSeek 官方网页版对话)的特殊视图 id,不映射到任何真实 harness 实例。 */
export const WEB_CHAT_ID = '__webchat__'
/** 官方网页版对话地址(内嵌视图加载它)。 */
export const WEB_CHAT_URL = 'https://chat.deepseek.com'

const views = new Map<string, WebContentsView>()
let win: BrowserWindow | null = null
let activeId: string | null = null
let active = false
let sidebarWidth = SIDEBAR_EXPANDED
const loaded = new Set<string>()
let onViewAdded: (() => void) | null = null

// 窗口 resize/move 时 Electron 每帧触发,直接对 WebContentsView setBounds 会让
// 内嵌页面每帧重排,低配电脑明显卡顿。节流:高频事件合并到 ~30ms 一次,并在事件
// 结束后补一次最终布局(保证松手/停稳后尺寸精确)。离散事件(切实例/侧栏宽)仍立即重排。
let relayoutTimer: ReturnType<typeof setTimeout> | null = null
let trailingTimer: ReturnType<typeof setTimeout> | null = null
// 尺寸 + 活动视图双因子:尺寸未变但活动视图变了(切实例/切网页聊天)也必须重排,
// 否则 setVisible(true/false) 不会执行 → 网页聊天打不开。
let lastLayout: { w: number; h: number; x: number; activeId: string | null } | null = null

// --- 拖动/缩放时冻结内嵌页 ---
// 内嵌 dsh 是独立 GPU 表面,拖动时它若持续满帧刷新,DWM 每帧重画两层会卡。检测拖动
// (轮询位置/尺寸,模态循环里可靠),拖动中把内嵌页限帧到 DRAG_FPS(1fps,可见但基本
// 不刷新),停稳 DRAG_SETTLE_MS 后恢复 —— 停稳瞬间补一帧。launcher 侧已去掉
// backgroundThrottling:false,被 dsh 遮挡时自身会被节流成静态,所以只剩这一个活跃源。
const DRAG_SETTLE_MS = 500 // 位置/尺寸连续不变该时长 → 结束(宽松)
const DRAG_POLL_MS = 100
const DRAG_FPS = 1 // 拖动中内嵌页帧率(≈冻结)
const RESTORE_FPS = 60
let dragging = false
let lastX = 0
let lastY = 0
let lastW = 0
let lastH = 0
let stillSince = 0
let dragPoll: ReturnType<typeof setInterval> | null = null

function setDragging(next: boolean): void {
  if (dragging === next) return
  dragging = next
  for (const [, v] of views) {
    v.webContents.setFrameRate(next ? DRAG_FPS : RESTORE_FPS)
  }
}

/** 轮询窗口位置/尺寸:任一变化即拖动/缩放中;连续 DRAG_SETTLE_MS 不变 → 结束。 */
function pollDrag(): void {
  if (!win) return
  const [x, y] = win.getPosition()
  const [w, h] = win.getSize()
  const changed = x !== lastX || y !== lastY || w !== lastW || h !== lastH
  lastX = x
  lastY = y
  lastW = w
  lastH = h
  if (changed) {
    stillSince = Date.now()
    if (!dragging) setDragging(true)
  } else if (dragging && Date.now() - stillSince >= DRAG_SETTLE_MS) {
    setDragging(false)
  }
}

function scheduleRelayout(): void {
  if (trailingTimer) clearTimeout(trailingTimer)
  trailingTimer = setTimeout(() => { trailingTimer = null; relayout() }, 60)
  if (relayoutTimer) return
  relayoutTimer = setTimeout(() => { relayoutTimer = null; relayout() }, 30)
}

/** Attach a host window. The views are created lazily on first activation. */
export function registerDshView(host: BrowserWindow): void {
  win = host
  host.on('resize', scheduleRelayout)
  const [ix, iy] = host.getPosition()
  const [iw, ih] = host.getSize()
  lastX = ix
  lastY = iy
  lastW = iw
  lastH = ih
  dragPoll = setInterval(pollDrag, DRAG_POLL_MS)
  // 新版 dsh 认证 token 到达时,若该实例是活动视图,用带 token 的 URL 重载
  // (否则内嵌视图加载的是基础 URL,会 401「authentication required」)。
  onInstanceAuthUrl((id, url) => {
    if (active && id === activeId && win) {
      const v = views.get(id)
      if (v) {
        void v.webContents.loadURL(url).then(() => consumeInstanceAuthUrl(id)).catch(() => {})
      }
    }
  })
  host.on('closed', () => {
    if (dragPoll) clearInterval(dragPoll)
    dragPoll = null
    dragging = false
    for (const v of views.values()) v.webContents.close()
    views.clear()
    loaded.clear()
    win = null
  })
}

/**
 * Register a callback fired whenever a new DSH view is added to the window.
 * The floating orb uses this to re-stack itself on top (child views draw in
 * addition order, so a view created later would cover it).
 */
export function onDshViewAdded(cb: () => void): void {
  onViewAdded = cb
}

/**
 * Show/hide the embedded DSH view for an instance. Pass `reload: true` when the
 * harness just (re)became ready, so a stale page from a previous run is
 * discarded.
 */
export function setDshActive(instanceId: string, next: boolean, reload?: boolean): void {
  active = next
  if (next) {
    activeId = instanceId
    if (win) {
      const v = ensureViewFor(instanceId)
      if (!v) return
      if (!loaded.has(instanceId) || reload) {
        loaded.add(instanceId)
        const port = getState(instanceId).port
        // 新版 dsh 认证:优先加载带 launchToken 的认证 URL(主进程持有),否则回退基础 URL。
        // token 用后即毁:加载成功(种 cookie)后销毁;全部退出时 dsh 必停,下次新 token。
        const authUrl = getInstanceAuthUrl(instanceId)
        if (port > 0) {
          const p = v.webContents.loadURL(authUrl ?? `http://127.0.0.1:${port}`)
          if (authUrl) void p.then(() => consumeInstanceAuthUrl(instanceId)).catch(() => { /* 失败保留 */ })
        }
      }
    }
  } else {
    activeId = null
  }
  relayout()
}

/**
 * Create the DSH view for an instance if it does not exist yet, and return its
 * webContents. Exported so the floating orb can ensure the active view is
 * already a child of the window before it adds itself — child views stack in
 * addition order, so the orb (added later) is always drawn on top.
 */
export function ensureView(): WebContents | undefined {
  if (!activeId) return undefined
  return ensureViewFor(activeId)?.webContents
}

function ensureViewFor(instanceId: string): WebContentsView | null {
  if (!win) return null
  let v = views.get(instanceId)
  if (!v) {
    v = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    win.contentView.addChildView(v)
    views.set(instanceId, v)
    // A fresh view lands on top of the existing stack — let the orb move back up.
    onViewAdded?.()
  }
  return v
}

let sidebarAnimTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Keep the view flush against the sidebar after it expands/collapses. 动画在主进程跑
 * (150ms easing,与渲染层原 CSS 过渡一致):渲染层被内嵌 dsh 遮挡时 rAF 会被节流,
 * 不能再靠渲染层驱动 —— 否则为迁就它就得关掉 backgroundThrottling(那是卡顿主因)。
 * 主进程 setTimeout 不受遮挡影响,天然平滑。
 */
export function setDshSidebarWidth(width: number): void {
  if (sidebarAnimTimer) clearTimeout(sidebarAnimTimer)
  const from = sidebarWidth
  if (from === width) { relayout(); return }
  const t0 = Date.now()
  const DUR = 150
  const tick = (): void => {
    const p = Math.min(1, (Date.now() - t0) / DUR)
    const eased = 1 - Math.pow(1 - p, 3)
    sidebarWidth = Math.round(from + (width - from) * eased)
    relayout()
    if (p < 1) {
      sidebarAnimTimer = setTimeout(tick, 16)
    } else {
      sidebarWidth = width
      relayout()
      sidebarAnimTimer = null
    }
  }
  sidebarAnimTimer = setTimeout(tick, 16)
}

let webChatUrl = WEB_CHAT_URL
let webChatWindow: import('electron').BrowserWindow | null = null

function openWebChatWindow(url: string): void {
  if (webChatWindow && !webChatWindow.isDestroyed()) {
    webChatWindow.loadURL(url)
    webChatWindow.focus()
    return
  }
  const w = new BrowserWindow({
    width: 1000,
    height: 760,
    autoHideMenuBar: true,
    backgroundColor: '#0e1013',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  webChatWindow = w
  w.loadURL(url)
  // 网页里的外链用系统浏览器打开,不让它替换对话窗口本身。
  w.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) void shell.openExternal(u)
    return { action: 'deny' }
  })
  w.on('closed', () => { webChatWindow = null })
}

/**
 * 打开 DeepSeek 官方网页版对话:
 * - popout=true  → 独立 BrowserWindow(和 dsh 弹出窗口同等的独立窗口)。
 * - popout=false → 应用内嵌 WebContentsView,和 DSH 视图一样贴侧边栏显示;
 *   关闭时 setWebChat(false) 隐藏。
 */
export function setWebChat(show: boolean, url: string, popout: boolean): void {
  if (popout) {
    openWebChatWindow(url)
    return
  }
  webChatUrl = url
  active = show
  activeId = show ? WEB_CHAT_ID : null
  if (show && win) {
    const v = ensureViewFor(WEB_CHAT_ID)
    if (v) void v.webContents.loadURL(url)
  }
  relayout()
}

/**
 * 移除某实例的嵌入式视图(实例删除时调用)。实例 id 是 UUID 不复用,不清理的话
 * 隐藏视图会一直驻留,白占一个 WebContents。同时避免「删除的实例恰好是活动视图」
 * 时残留的 activeId 指向已删除实例。
 */
export function removeDshView(instanceId: string): void {
  // 实例删除时一并清理认证 token。
  consumeInstanceAuthUrl(instanceId)
  const v = views.get(instanceId)
  if (!v) return
  if (activeId === instanceId) {
    activeId = null
    active = false
  }
  views.delete(instanceId)
  loaded.delete(instanceId)
  v.webContents.close()
  relayout()
}

function relayout(): void {
  if (!win) return
  const [w, h] = win.getContentSize()
  const x = sidebarWidth
  // 尺寸与活动视图都未变才跳过,避免 setBounds 空跑;活动视图变了则必须重排。
  if (lastLayout && lastLayout.w === w && lastLayout.h === h && lastLayout.x === x && lastLayout.activeId === activeId) return
  lastLayout = { w, h, x, activeId }
  for (const [id, v] of views) {
    if (active && id === activeId) {
      v.setBounds({ x, y: 0, width: Math.max(0, w - x), height: h })
      v.setVisible(true)
    } else {
      v.setVisible(false)
    }
  }
}
