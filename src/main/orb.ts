// Floating whale orb: a small transparent WebContentsView layered on top of
// the embedded DSH view. When "floatingWhale" is enabled in Settings, the
// sidebar rail disappears in the DSH view and this orb takes its place — it
// can be dragged anywhere by pressing and holding it, and a short click sends
// it back to the top-left corner while expanding the launcher menu.
//
// It has to be a separate WebContentsView (not a plain React element) because
// the DSH view is itself a native child view drawn above the launcher window's
// renderer — ordinary DOM content can never float over it.

import { WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as dshview from './dshview'
import { preloadPath } from './preload'

/** Size of the orb view (the ball inside is smaller, leaving room for its shadow). */
const ORB_SIZE = 56
const ORB_MARGIN = 12

const here = dirname(fileURLToPath(import.meta.url))

let orb: WebContentsView | null = null
let win: BrowserWindow | null = null
let pos = { x: ORB_MARGIN, y: ORB_MARGIN }
/**
 * Where the orb last sat before it was clicked away (i.e. the spot the user
 * dragged it to). Re-entering the DSH view restores this position instead of
 * resetting to the top-left corner.
 */
let lastPos: { x: number; y: number } | null = null
/** Grab offset within the orb view (in view coordinates) while dragging. */
let grab: { ox: number; oy: number } | null = null
let shown = false

/** Attach a host window. The orb view is created lazily on first use. */
export function registerOrb(host: BrowserWindow): void {
  win = host
  host.on('resize', () => {
    if (shown) clampAndPlace()
  })
  // A DSH view created later (new instance) would land on top of the orb —
  // re-append the orb so it stays the topmost child.
  dshview.onDshViewAdded(restack)
  host.on('closed', () => {
    cancelAnim()
    orb?.webContents.close()
    orb = null
    win = null
    grab = null
  })
}

function ensure(): WebContentsView {
  if (!orb && win) {
    // Make sure the DSH view is already a child of the window so this orb is
    // stacked on top of it (child views draw in addition order).
    dshview.ensureView()
    orb = new WebContentsView({
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        // sandbox must be off: the shared preload is ESM, and sandboxed
        // preloads can't use import statements. The orb only ever runs our own
        // bundled OrbWidget, so this matches the launcher window's posture.
        sandbox: false
      }
    })
    orb.setBackgroundColor('#00000000')
    win.contentView.addChildView(orb)
    // If the orb page ever crashes, drop the view so the next show recreates a
    // fresh one — a dead-but-visible view looks like a vanished ball.
    orb.webContents.on('render-process-gone', (_e, d) => {
      console.log(`[orb] render-process-gone: ${d.reason}`)
      destroyOrb()
    })
    orb.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`[orb] did-fail-load: ${code} ${desc}`)
    })
    orb.webContents.on('preload-error', (_e, p, err) => {
      console.log(`[orb] preload-error: ${p} ${err}`)
    })
    loadOrb(orb.webContents)
  }
  return orb!
}

/** Tear down a dead orb view so the next ensure() builds a fresh one. */
function destroyOrb(): void {
  if (!orb || !win) return
  try {
    win.contentView.removeChildView(orb)
  } catch {
    /* view already gone */
  }
  try {
    orb.webContents.close()
  } catch {
    /* webContents already closed */
  }
  orb = null
  grab = null
}

/** Re-append the orb as the window's last child so it stays on top of all DSH views. */
function restack(): void {
  if (!win || !orb) return
  try {
    win.contentView.removeChildView(orb)
    win.contentView.addChildView(orb)
  } catch {
    /* view may already be gone */
  }
}

function loadOrb(wc: WebContents): void {
  // Same renderer bundle, told to draw only the orb via the `orb` query flag.
  const base = process.env.ELECTRON_RENDERER_URL
  if (base) {
    void wc.loadURL(`${base}?orb=1`)
  } else {
    void wc.loadFile(join(here, '../renderer/index.html'), { query: { orb: '1' } })
  }
}

/** Show the orb while the DSH view is open in "floatingWhale" mode; hide otherwise. */
export function setOrbVisible(visible: boolean): void {
  cancelAnim()
  shown = visible
  if (visible && win) {
    const v = ensure()
    // Re-entering the DSH view restores wherever the orb last sat (set by a
    // click); on the very first entry lastPos is null and it starts top-left.
    if (lastPos) pos = { ...lastPos }
    clampAndPlace()
    v.setVisible(true)
    console.log(`[orb] show at ${pos.x},${pos.y}`)
  } else if (orb) {
    orb.setVisible(false)
    grab = null
    console.log('[orb] hide')
  }
}

function clampAndPlace(): void {
  if (!win || !orb) return
  const cb = win.getContentBounds()
  const maxX = Math.max(0, cb.width - ORB_SIZE)
  const maxY = Math.max(0, cb.height - ORB_SIZE)
  pos = {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY)
  }
  orb.setBounds({ x: pos.x, y: pos.y, width: ORB_SIZE, height: ORB_SIZE })
}

/** The orb page reports a press start with the grab point in view coordinates. */
export function orbDragStart(ox: number, oy: number): void {
  cancelAnim()
  grab = { ox, oy }
}

/** The orb page reports the pointer's absolute screen position while dragging. */
export function orbDragMove(sx: number, sy: number): void {
  if (!win || !orb || !grab) return
  const cb = win.getContentBounds()
  const x = Math.round(sx - cb.x - grab.ox)
  const y = Math.round(sy - cb.y - grab.oy)
  const maxX = Math.max(0, cb.width - ORB_SIZE)
  const maxY = Math.max(0, cb.height - ORB_SIZE)
  pos = {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY)
  }
  orb.setBounds({ x: pos.x, y: pos.y, width: ORB_SIZE, height: ORB_SIZE })
}

/** The orb page finished dragging — keep the current position. */
export function orbDragEnd(): void {
  grab = null
}

/** Pending return-to-corner animation timer (cancellable). */
let anim: ReturnType<typeof setTimeout> | null = null

function cancelAnim(): void {
  if (anim) {
    clearTimeout(anim)
    anim = null
  }
}

/**
 * The orb was clicked (short press): slide it back to the top-left corner,
 * then expand the launcher menu. Without the slide, a ball dragged out to the
 * right just vanishes the instant it's clicked — the slide makes the "return
 * to corner" legible. The menu expansion is what hides the ball: the renderer
 * flips `collapsed` on `orb:clicked`, orbMode turns off, and setOrbVisible
 * hides it (it must hide once the sidebar expands — the orb is a native child
 * view that would otherwise sit on top of the sidebar).
 */
export function orbClick(): void {
  if (!win) return
  // Remember where the user had dragged it before expanding the menu, so it
  // comes back there when they return to the DSH view.
  lastPos = { ...pos }
  const start = { ...pos }
  const saved = { ...lastPos }
  cancelAnim()
  // Same 150ms easeOutCubic as the sidebar width transition, so the return
  // feels like part of the menu opening rather than a jump.
  const DUR = 150
  const t0 = Date.now()
  const step = (): void => {
    const p = Math.min(1, (Date.now() - t0) / DUR)
    const eased = 1 - Math.pow(1 - p, 3)
    pos = {
      x: Math.round(start.x + (ORB_MARGIN - start.x) * eased),
      y: Math.round(start.y + (ORB_MARGIN - start.y) * eased)
    }
    clampAndPlace()
    if (p < 1) {
      anim = setTimeout(step, 16)
    } else {
      anim = null
      console.log(`[orb] click (saved ${saved.x},${saved.y}, returned to corner)`)
      win!.webContents.send('orb:clicked')
      win!.focus()
    }
  }
  step()
}
