import { BrowserWindow } from 'electron'
import type { LauncherEvent } from '../shared/types'

let win: BrowserWindow | null = null
const listeners = new Set<(e: LauncherEvent) => void>()

/** Attach the window that receives broadcast events. */
export function bindWindow(w: BrowserWindow): void {
  win = w
}

/** The launcher window (parent for popup child windows), or null before it exists. */
export function getWindow(): BrowserWindow | null {
  return win
}

/** Subscribe an in-process listener to every broadcast event; returns an unsubscribe. */
export function onEvent(cb: (e: LauncherEvent) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Broadcast to in-process listeners and the renderer (if attached). */
export function broadcast(e: LauncherEvent): void {
  for (const l of listeners) l(e)
  if (win && !win.isDestroyed()) win.webContents.send('harness:event', e)
}
