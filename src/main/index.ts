import { app, BrowserWindow, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindWindow } from './bus'
import { getConfig } from './config'
import * as dshStatus from './dsh-status'
import { registerDshView } from './dshview'
import { registerIpc } from './ipc'
import { registerOrb } from './orb'
import { start as startDsh, stopSync } from './harness'
import { ensureShortcuts } from './shortcuts'
import { preloadPath } from './preload'
import { hideToTray, initTray, markQuitting, showLauncher } from './tray'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Whale window icon. In dev this resolves under the project root (packaged via
 * `extraResources` to `<install>/resources/icon.png`); in the packaged app the
 * `process.resourcesPath` copy wins. Missing file ⇒ undefined ⇒ Windows uses
 * the exe icon (also the whale), so this never breaks anything.
 */
function appIconPath(): string | undefined {
  for (const p of [join(process.resourcesPath, 'icon.png'), join(app.getAppPath(), 'resources', 'icon.png')]) {
    if (existsSync(p)) return p
  }
  return undefined
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    title: 'DSH Launcher',
    backgroundColor: '#0e1013',
    icon: appIconPath(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The DSH view is a native child view drawn on top of this window's
      // renderer — while the embedded page covers the window, Chromium treats
      // the launcher renderer as backgrounded and throttles requestAnimationFrame
      // to (almost) nothing. The sidebar ↔ DSH width animation below lives on
      // rAF, so without this the sidebar appears stuck until the window is
      // resized (which forces a relayout). A launcher that always needs to
      // respond should never throttle its own frames.
      backgroundThrottling: false
    }
  })

  bindWindow(win)
  registerDshView(win)
  registerOrb(win)
  // closeToTray: swallow the close and hide to the tray (unless actually quitting).
  win.on('close', (e) => {
    if (hideToTray()) e.preventDefault()
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(here, '../renderer/index.html'))
  }
  return win
}

// Single instance: re-running the exe / desktop shortcut while the app is
// already alive (typically hidden to the tray) must bring the existing window
// back instead of spawning a second process.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showLauncher()
  })

  app.whenReady().then(() => {
    // Ensure the plugin folder and dsh home physically exist on a fresh machine —
    // the Settings paths are computed from homedir() and are otherwise created
    // lazily (plugins.ts on first GitHub install / dsh on first run), which leaves
    // a dangling-looking path on a brand-new install.
    const cfg = getConfig()
    for (const dir of [cfg.pluginDir, cfg.dshHome]) {
      if (dir) {
        try {
          mkdirSync(dir, { recursive: true })
        } catch {
          /* ignore — the folder is created lazily elsewhere anyway */
        }
      }
    }
    registerIpc()
    dshStatus.init()
    ensureShortcuts()
    // autoStartOnLaunch (Settings): start dsh as soon as the app boots, before
    // the window is created, so it boots in parallel with the startup splash —
    // by the time the animation ends, dsh is usually already ready.
    if (getConfig().autoStartOnLaunch) {
      void startDsh().then((r) => {
        if (!r.ok) console.error('[launcher] auto-start failed:', r.error)
      })
    }
    const win = createWindow()
    initTray(win)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // closeToTray keeps the window alive (hidden), so this only fires when the
    // close-to-tray setting is off and the last window really closed.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    markQuitting()
    if (getConfig().stopOnQuit) stopSync()
  })
}
