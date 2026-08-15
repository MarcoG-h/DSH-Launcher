// Portable shortcut maintenance: create/repair the desktop + start-menu .lnk
// so a portable build behaves like an installed app. Idempotent — skips when
// the link already points at the running executable, rebuilds broken ones.

import { spawn } from 'node:child_process'
import { app } from 'electron'

const SHORTCUT_NAME = 'DSH Launcher.lnk'
const START_MENU_FOLDER = 'DSH Launcher'

/**
 * Ensure desktop + start-menu shortcuts for the packaged app. No-op in dev
 * (avoids shortcutting electron.exe) and on non-Windows.
 */
export function ensureShortcuts(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return

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
  child.unref()
}
