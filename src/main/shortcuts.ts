// Portable shortcut maintenance: create the desktop + start-menu .lnk ONCE on
// the first run of a packaged build (a portable app has no installer step). A
// sentinel file in userData records that creation happened, so later launches
// never touch the shortcuts again — even if the user deletes one. This matches
// "create on install only", NOT "repair every launch".

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const SHORTCUT_NAME = 'DSH Launcher.lnk'
const START_MENU_FOLDER = 'DSH Launcher'
/** Sentinel marking that the first-run shortcut creation already happened. */
const SENTINEL = '.shortcuts-created'

/**
 * Create desktop + start-menu shortcuts for the packaged app, once. No-op in
 * dev (avoids shortcutting electron.exe) and on non-Windows. The sentinel is
 * written only after the creation actually succeeded (exit 0), so a failed
 * first attempt is retried on the next launch; once written, every later
 * launch skips entirely.
 */
export function ensureShortcuts(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  if (existsSync(join(app.getPath('userData'), SENTINEL))) return

  const target = process.execPath
  const work = app.getAppPath()

  const script = `
$ErrorActionPreference = "Stop"
$target = ${JSON.stringify(target)}
$work = ${JSON.stringify(work)}
$name = ${JSON.stringify(SHORTCUT_NAME)}
function Ensure-Link($dir) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $path = Join-Path $dir $name
  $ws = New-Object -ComObject WScript.Shell
  try {
    $ex = $ws.CreateShortcut($path)
    if ($ex.TargetPath -eq $target) { return }
  } catch {}
  $sc = $ws.CreateShortcut($path)
  $sc.TargetPath = $target
  $sc.WorkingDirectory = $work
  $sc.IconLocation = "$target,0"
  $sc.Description = "DSH Launcher"
  $sc.Save()
}
Ensure-Link ([Environment]::GetFolderPath('Desktop'))
Ensure-Link (Join-Path ([Environment]::GetFolderPath('Programs')) ${JSON.stringify(START_MENU_FOLDER)})
`.trim()

  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore'
  })
  child.on('error', (err) => console.error('shortcuts: failed to run powershell:', err))
  child.on('close', (code) => {
    // Record the creation only on success — a nonzero exit means the shortcuts
    // were not made, so leave the sentinel absent to retry next launch.
    if (code !== 0) {
      console.error(`shortcuts: powershell exited ${code}; not recorded — will retry on next launch`)
      return
    }
    try {
      writeFileSync(join(app.getPath('userData'), SENTINEL), 'ok\n')
    } catch (err) {
      console.error('shortcuts: failed to write sentinel:', err)
    }
  })
  child.unref()
}
