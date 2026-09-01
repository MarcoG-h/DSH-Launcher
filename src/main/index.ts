import { app, BrowserWindow, screen, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindWindow, broadcast } from './bus'
import { getConfig, setConfig } from './config'
import * as dshStatus from './dsh-status'
import { registerDshView } from './dshview'
import { registerIpc } from './ipc'
import { registerOrb } from './orb'
import { startAllAutoStart, stopAllSync } from './harness'
import * as plugins from './plugins'
import * as runtime from './runtime'
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
  // Windows 任务栏图标用 .ico 才可靠(PNG 经常显示成默认/空白图标)。
  // 开发模式优先 build/icon.ico(打包时 electron-builder 用它生成 exe 图标);
  // 打包后回退 resources/icon.ico / icon.png。
  for (const p of [
    join(process.resourcesPath, 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'resources', 'icon.png')
  ]) {
    if (existsSync(p)) return p
  }
  return undefined
}

function createWindow(): BrowserWindow {
  // 窗口大小/位置记忆:显示器数量与上次一致、且位置落在某个显示器工作区内时恢复,
  // 否则用默认——防止显示器插拔/变动后窗口出现在屏幕外导致「打开失败」。
  const displays = screen.getAllDisplays()
  const wb = getConfig().windowBounds
  let restore: { x: number; y: number; width: number; height: number } | undefined
  if (wb && wb.displayCount === displays.length && wb.width > 0 && wb.height > 0) {
    const r = { x: wb.x, y: wb.y, width: wb.width, height: wb.height }
    const onScreen = displays.some((d) => {
      const a = d.workArea
      return r.x < a.x + a.width && r.x + r.width > a.x && r.y < a.y + a.height && r.y + r.height > a.y
    })
    if (onScreen) restore = r
  }
  const win = new BrowserWindow({
    ...(restore ?? { width: 1180, height: 760 }),
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

  // 停止调整 500ms 后保存窗口位置/大小(供下次启动恢复),同时记录显示器数量。
  let saveTimer: NodeJS.Timeout | null = null
  const saveBounds = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const b = win.getBounds()
      setConfig({
        windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height, displayCount: screen.getAllDisplays().length }
      })
    }, 500)
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)

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
    // 启动时全 profile 健康修复:移除插件树里悬空的引用(包已从本地库/依赖删除但
    // cordis.patch.yml 还挂着),防止下次启动时 include-loader 导入不存在的包崩溃。
    try {
      plugins.repairAllProfiles()
    } catch { /* 修复失败不阻塞启动 */ }
    // 立即广播当前 dsh 版本(读本地文件,不依赖网络),否则版本显示会等 checkDshUpdate
    // 的网络查询(最长 8s 超时)后才更新 → 显示成「源码版」。最新版随后异步补上。
    broadcast({ type: 'dsh-update', latest: null, current: runtime.currentDshVersion() })
    // 后台检查官方 dsh 是否有新版本(不阻塞启动,网络失败静默)。结果广播给 UI。
    void runtime.checkDshUpdate().then((r) => broadcast({ type: 'dsh-update', latest: r.latest, current: r.current }))
    // 提示式更新:后台检查 DSH-Launcher 自身是否有新版 Release(网络失败静默)。
    void runtime.checkLauncherUpdate().then((r) => broadcast({ type: 'launcher-update', latest: r.latest, current: r.current, url: r.url, update: r.update }))
    // autoStartOnLaunch (Settings): start every instance flagged autoStart as
    // soon as the app boots, before the window is created, so they boot in
    // parallel with the startup splash — by the time the animation ends, dsh is
    // usually already ready.
    if (getConfig().autoStartOnLaunch) {
      startAllAutoStart()
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
    if (getConfig().stopOnQuit) stopAllSync()
  })
}
