import { ipcMain, shell } from 'electron'
import * as balance from './balance'
import { getConfig, setConfig } from './config'
import * as dshview from './dshview'
import * as harness from './harness'
import * as plugins from './plugins'
import * as runtime from './runtime'
import { registerEmbeddedView } from './webview'

export function registerIpc(): void {
  registerEmbeddedView()
  ipcMain.handle('state:get', () => ({
    state: harness.getState(),
    log: harness.getLog().slice(-800),
    config: getConfig()
  }))

  ipcMain.handle('harness:start', () => harness.start())
  ipcMain.handle('harness:stop', () => harness.stop())
  ipcMain.handle('harness:restart', () => harness.restart())
  ipcMain.handle('harness:openUi', () => shell.openExternal(`http://127.0.0.1:${getConfig().port}`))

  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', (_e, patch: Partial<typeof getConfig>) => setConfig(patch))

  ipcMain.handle('plugins:list', () => plugins.listPlugins())
  ipcMain.handle('plugins:install', (_e, spec: string) => plugins.install(getConfig().profile, String(spec)))
  ipcMain.handle('plugins:remove', (_e, name: string) => plugins.remove(getConfig().profile, String(name)))
  ipcMain.handle('plugins:setEnabled', (_e, name: string, enabled: boolean) =>
    plugins.setEnabled(getConfig().profile, String(name), Boolean(enabled))
  )

  ipcMain.handle('build:repair', () => plugins.repairDeps())
  ipcMain.handle('build:rebuild', () => plugins.rebuild())
  ipcMain.handle('download:harness', () => plugins.downloadHarness())
  ipcMain.handle('download:plugin', (_e, url: string) => plugins.downloadPlugin(String(url)))

  // Install/upgrade of the portable runtime must not race a running harness
  // (npm writes the files the bundled dsh is executing).
  const busyGuard = (fn: () => Promise<{ ok: boolean }>): (() => Promise<{ ok: boolean; code: number | null; error?: string }>) => {
    return async () => {
      const st = harness.getState().status
      if (st === 'running' || st === 'starting' || st === 'stopping') {
        return { ok: false, code: null, error: '请先停止 dsh,再安装 / 更新运行环境。' }
      }
      return (await fn()) as { ok: boolean; code: number | null; error?: string }
    }
  }
  ipcMain.handle('runtime:install', busyGuard(runtime.installRuntime))
  ipcMain.handle('runtime:update', busyGuard(runtime.updateRuntime))

  ipcMain.handle('balance:get', () => balance.getBalance())

  // Embedded DSH view (native WebContentsView) — bounds follow the sidebar.
  ipcMain.on('dsh:set-active', (_e, active: boolean, reload?: boolean) =>
    dshview.setDshActive(Boolean(active), Boolean(reload))
  )
  ipcMain.on('dsh:set-sidebar-width', (_e, width: number) => dshview.setDshSidebarWidth(Number(width)))
}
