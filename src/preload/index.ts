import { contextBridge, ipcRenderer } from 'electron'
import type { DshLauncherApi, LauncherEvent } from '../shared/types'

const api: DshLauncherApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  start: () => ipcRenderer.invoke('harness:start'),
  stop: () => ipcRenderer.invoke('harness:stop'),
  restart: () => ipcRenderer.invoke('harness:restart'),
  openUi: () => ipcRenderer.invoke('harness:openUi'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  installPlugin: (spec) => ipcRenderer.invoke('plugins:install', spec),
  removePlugin: (name) => ipcRenderer.invoke('plugins:remove', name),
  setPluginEnabled: (name, enabled) => ipcRenderer.invoke('plugins:setEnabled', name, enabled),
  repairDeps: () => ipcRenderer.invoke('build:repair'),
  rebuild: () => ipcRenderer.invoke('build:rebuild'),
  downloadHarness: () => ipcRenderer.invoke('download:harness'),
  downloadPlugin: (url) => ipcRenderer.invoke('download:plugin', url),
  installRuntime: () => ipcRenderer.invoke('runtime:install'),
  updateRuntime: () => ipcRenderer.invoke('runtime:update'),
  getBalance: () => ipcRenderer.invoke('balance:get'),
  setDshActive: (active, reload) => ipcRenderer.send('dsh:set-active', active, reload),
  setDshSidebarWidth: (width) => ipcRenderer.send('dsh:set-sidebar-width', width),
  onEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, data: LauncherEvent): void => cb(data)
    ipcRenderer.on('harness:event', listener)
    return () => {
      ipcRenderer.removeListener('harness:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('dshLauncher', api)
