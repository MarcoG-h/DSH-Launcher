// System tray: keeps the launcher alive in the background when the window is
// closed with closeToTray enabled, and provides Show/Quit actions. The icon is
// a generated PNG embedded as base64 so no resource path exists to break in
// dev vs packaged builds.
import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { getConfig } from './config'
import { t } from './i18n'

// 32×32 RGBA: white disc + the little black whale on top — matches the
// sidebar logo, and the white disc keeps the dark whale visible on both light
// and dark taskbars.
const ICON_BASE64 =
  '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'

let tray: Tray | null = null
let win: BrowserWindow | null = null
let quitting = false
let notified = false

export function isQuitting(): boolean {
  return quitting
}

/** Set before app.quit() so the window's close handler doesn't hide to tray. */
export function markQuitting(): void {
  quitting = true
}

/**
 * Bring the launcher window to the front — used by the tray menu, tray
 * double-click, and the single-instance handler when the desktop shortcut is
 * re-run while the app is already hidden to the tray.
 */
export function showLauncher(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function initTray(window: BrowserWindow): void {
  win = window
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_BASE64}`)
  tray = new Tray(icon)
  tray.setToolTip('DSH Launcher')
  const menu = Menu.buildFromTemplate([
    { label: t('显示主界面', 'Show Launcher'), click: showLauncher },
    { type: 'separator' },
    {
      label: t('退出', 'Quit'),
      click: () => {
        markQuitting()
        app.quit()
      }
    }
  ])
  // Left-click (and double-click) brings the window back. On Windows a context
  // menu attached via setContextMenu swallows the left click, so the menu is
  // popped up manually on right-click only.
  tray.on('click', showLauncher)
  tray.on('double-click', showLauncher)
  tray.on('right-click', () => tray?.popUpContextMenu(menu))
}

/**
 * Called from the window `close` handler. Returns true when the close was
 * swallowed and the window hidden to the tray instead.
 */
export function hideToTray(): boolean {
  if (quitting || !getConfig().closeToTray) return false
  win?.hide()
  if (!notified) {
    notified = true
    tray?.displayBalloon({
      title: 'DSH Launcher',
      content: t('已最小化到系统托盘,仍在后台运行。', 'Minimized to system tray; still running in the background.')
    })
  }
  return true
}
