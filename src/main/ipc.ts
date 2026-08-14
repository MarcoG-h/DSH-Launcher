import { ipcMain, shell } from 'electron'
import { getConfig, setConfig } from './config'
import * as harness from './harness'
import * as plugins from './plugins'

export function registerIpc(): void {
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
}
