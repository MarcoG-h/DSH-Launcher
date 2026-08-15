// Hosts the DSH Web UI in a native WebContentsView, positioned flush against
// the right edge of the launcher sidebar.
//
// The legacy <webview> tag routes the guest through the host renderer's DOM,
// which breaks IME composition and places the IME candidate window at the
// wrong coordinates. A WebContentsView is a first-class child of the window's
// content view, so keyboard focus and IME work natively.

import { WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { getConfig } from './config'

const SIDEBAR_EXPANDED = 212
const SIDEBAR_COLLAPSED = 56

let view: WebContentsView | null = null
let win: BrowserWindow | null = null
let active = false
let sidebarWidth = SIDEBAR_EXPANDED
let loaded = false

/** Attach a host window. The view itself is created lazily on first activation. */
export function registerDshView(host: BrowserWindow): void {
  win = host
  host.on('resize', relayout)
  host.on('closed', () => {
    view?.webContents.close()
    view = null
    win = null
    loaded = false
  })
}

/**
 * Show/hide the embedded DSH view. Pass `reload: true` when the harness just
 * (re)became ready, so a stale page from a previous run is discarded.
 */
export function setDshActive(next: boolean, reload?: boolean): void {
  active = next
  if (next && (!loaded || reload) && win) {
    loaded = true
    void ensure().loadURL(`http://127.0.0.1:${getConfig().port}`)
  }
  relayout()
}

/** Keep the view flush against the sidebar after it expands/collapses. */
export function setDshSidebarWidth(width: number): void {
  sidebarWidth = width
  relayout()
}

function ensure(): WebContents {
  if (!view && win) {
    view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    win.contentView.addChildView(view)
  }
  return view!.webContents
}

function relayout(): void {
  if (!win || !view) return
  if (active) {
    const [w, h] = win.getContentSize()
    const x = sidebarWidth
    view.setBounds({ x, y: 0, width: Math.max(0, w - x), height: h })
    view.setVisible(true)
  } else {
    view.setVisible(false)
  }
}
