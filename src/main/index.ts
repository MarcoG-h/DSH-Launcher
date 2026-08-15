import { app, BrowserWindow, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindWindow } from './bus'
import { getConfig } from './config'
import { registerDshView } from './dshview'
import { registerIpc } from './ipc'
import { stopSync } from './harness'
import { ensureShortcuts } from './shortcuts'

const here = dirname(fileURLToPath(import.meta.url))

function preloadPath(): string {
  const base = join(here, '../preload')
  for (const name of ['index.mjs', 'index.js']) {
    const p = join(base, name)
    if (existsSync(p)) return p
  }
  return join(base, 'index.mjs')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    title: 'DSH Launcher',
    backgroundColor: '#0e1013',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  bindWindow(win)
  registerDshView(win)
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
  ensureShortcuts()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (getConfig().stopOnQuit) stopSync()
})
