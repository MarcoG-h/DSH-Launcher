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
  updatePlugin: (name) => ipcRenderer.invoke('plugins:update', name),
  setPluginEnabled: (name, enabled) => ipcRenderer.invoke('plugins:setEnabled', name, enabled),
  repairDeps: () => ipcRenderer.invoke('build:repair'),
  rebuild: () => ipcRenderer.invoke('build:rebuild'),
  downloadHarness: () => ipcRenderer.invoke('download:harness'),
  downloadPlugin: (url, subdir) => ipcRenderer.invoke('download:plugin', url, subdir),
  installRuntime: () => ipcRenderer.invoke('runtime:install'),
  updateRuntime: () => ipcRenderer.invoke('runtime:update'),
  getBalance: () => ipcRenderer.invoke('balance:get'),
  searchMarket: (page, query) => ipcRenderer.invoke('market:search', page, query),
  fetchMarketReadme: (owner, repo) => ipcRenderer.invoke('market:readme', owner, repo),
  confirmOpenExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  setDshActive: (active, reload) => ipcRenderer.send('dsh:set-active', active, reload),
  setDshSidebarWidth: (width) => ipcRenderer.send('dsh:set-sidebar-width', width),
  setOrbVisible: (visible) => ipcRenderer.send('orb:set-visible', visible),
  orbDragStart: (ox, oy) => ipcRenderer.send('orb:drag-start', ox, oy),
  orbDragMove: (sx, sy) => ipcRenderer.send('orb:drag-move', sx, sy),
  orbDragEnd: () => ipcRenderer.send('orb:drag-end'),
  orbClick: () => ipcRenderer.send('orb:click'),
  onOrbClicked: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('orb:clicked', listener)
    return () => {
      ipcRenderer.removeListener('orb:clicked', listener)
    }
  },
  onEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, data: LauncherEvent): void => cb(data)
    ipcRenderer.on('harness:event', listener)
    return () => {
      ipcRenderer.removeListener('harness:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('dshLauncher', api)
