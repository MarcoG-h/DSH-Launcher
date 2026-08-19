// Launcher child windows: each one shows one instance's DSH Web UI in its own
// top-level BrowserWindow (drag it to another monitor for multi-screen work),
// as opposed to the Dashboard's "open UI" button which opens the system browser.
//
// A popup is a child of the launcher window (parent) and tracks its instance's
// lifecycle: it is closed the moment the instance stops (the page would be dead
// anyway), and opening the same instance again just focuses the existing window.
// It loads the page directly from the harness, so no preload / IPC is needed —
// it is a plain web window pointed at dsh.

import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { broadcast, getWindow, onEvent } from './bus'
import { getState } from './harness'
import { getInstance } from './instances'

const popups = new Map<string, BrowserWindow>()

/** Whale window icon, mirroring the launcher window's. */
function popupIconPath(): string | undefined {
  for (const p of [join(process.resourcesPath, 'icon.png'), join(app.getAppPath(), 'resources', 'icon.png')]) {
    if (existsSync(p)) return p
  }
  return undefined
}

/** Whether the instance currently runs in a separate (popped-out) window. */
export function isPoppedOut(instanceId: string): boolean {
  const w = popups.get(instanceId)
  return !!w && !w.isDestroyed()
}

/**
 * Open (or focus) a launcher child window showing the instance's DSH Web UI.
 * The instance is now "popped out" (multi-screen); the renderer switches the
 * embedded view off. Broadcasting `{type:'popup', open:true}` lets it keep the
 * toggle state in sync.
 */
export function openInstanceWindow(instanceId: string): void {
  const existing = popups.get(instanceId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const st = getState(instanceId)
  if (!st || st.port <= 0) return
  const inst = getInstance(instanceId)
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: `DSH · ${inst?.name ?? inst?.profile ?? instanceId}`,
    backgroundColor: '#0e1013',
    icon: popupIconPath(),
    autoHideMenuBar: true,
    parent: getWindow() ?? undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  popups.set(instanceId, win)
  // The instance name in the title is what tells several popups apart on a
  // multi-screen setup — don't let the dsh page replace it with its own title.
  win.on('page-title-updated', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  void win.loadURL(`http://127.0.0.1:${st.port}`)
  win.on('closed', () => {
    if (popups.get(instanceId) === win) popups.delete(instanceId)
    // Closing the separate window (by hand or from the toggle button) pops the
    // instance back into the launcher — the renderer returns to the embedded
    // view on `open:false`.
    broadcast({ type: 'popup', instanceId, open: false })
  })
  broadcast({ type: 'popup', instanceId, open: true })
}

/** Close the instance's separate window (the toggle-back action). */
export function closeInstanceWindow(instanceId: string): void {
  const w = popups.get(instanceId)
  if (w && !w.isDestroyed()) w.close()
}

// Close an instance's popup the moment it is no longer running — the page it
// hosts is dead (or about to be), and a stale URL on restart would be wrong.
// The `closed` handler above broadcasts `open:false`, so the renderer's toggle
// state and the embedded-view return follow automatically.
onEvent((e) => {
  if (e.type !== 'state') return
  const w = popups.get(e.state.instanceId)
  if (!w || w.isDestroyed()) return
  if (e.state.status !== 'running' && e.state.status !== 'external') {
    w.close()
  }
})
