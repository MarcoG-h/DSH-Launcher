import { BrowserWindow } from 'electron'
import type { LauncherEvent } from '../shared/types'

let win: BrowserWindow | null = null
const listeners = new Set<(e: LauncherEvent) => void>()

/** Attach the window that receives broadcast events. */
export function bindWindow(w: BrowserWindow): void {
  win = w
}

/** Broadcast to in-process listeners and the renderer (if attached). */
export function broadcast(e: LauncherEvent): void {
  for (const l of listeners) l(e)
  if (win && !win.isDestroyed()) win.webContents.send('harness:event', e)
}
