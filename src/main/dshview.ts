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

// --- 窗口拖动降负载 ---
// WebContentsView 是独立合成器/GPU surface,窗口拖动时 DWM 每帧要把 launcher 渲染层
// 和内嵌页两层一起重画,低配机器明显卡顿。resize 节流只挂 resize 事件,管不到 move;
// 这里单独检测拖动:连续两次 move 间隔短于 DRAG_BURST_WINDOW 判定「拖动中」,立即把
// 全部内嵌视图挂起(只留 launcher 单层合成),停稳 DRAG_SETTLE_MS 后恢复。同时把拖动
// 状态广播给渲染层,暂停无限 CSS 动画,进一步降低拖动期间的单层合成开销。
const DRAG_BURST_WINDOW = 120 // 两次 move 间隔短于该值视为正在拖动
const DRAG_SETTLE_MS = 250 // 最后一次 move 后停稳该时长 → 拖动结束
let dragging = false
let lastMoveAt = 0
let dragSettleTimer: ReturnType<typeof setTimeout> | null = null

function setDragging(next: boolean): void {
  if (dragging === next) return
  dragging = next
  // 隐藏/恢复视图必须绕过 lastLayout 免重排判断,否则 setVisible 不会真正执行。
  lastLayout = null
  relayout()
  // 广播给渲染层暂停无限动画(流光/脉冲),拖动结束后恢复。
  win?.webContents.send('window:dragging', next)
}

function onHostMove(): void {
  const now = Date.now()
  // 第一次 move 只记时间;第二次起如果间隔很短,说明用户在拖动窗口。
  if (!dragging && lastMoveAt !== 0 && now - lastMoveAt <= DRAG_BURST_WINDOW) setDragging(true)
  lastMoveAt = now
  if (dragSettleTimer) clearTimeout(dragSettleTimer)
  dragSettleTimer = setTimeout(() => {
    dragSettleTimer = null
    if (dragging) setDragging(false)
  }, DRAG_SETTLE_MS)
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
  // 拖动检测:move 不触发 resize,节流管不到,单独处理(见上方 onHostMove)。
  host.on('move', onHostMove)
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
    if (dragSettleTimer) clearTimeout(dragSettleTimer)
    dragSettleTimer = null
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

/** Keep the view flush against the sidebar after it expands/collapses. */
export function setDshSidebarWidth(width: number): void {
  sidebarWidth = width
  relayout()
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
  // 拖动中:全部挂起,只留 launcher 一层合成。尺寸停稳后再算(停稳时 setDragging(false)
  // 会把 lastLayout 置空并强制重排,届时恢复视图并补齐精确 bounds)。
  if (dragging) {
    for (const [, v] of views) v.setVisible(false)
    return
  }
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
