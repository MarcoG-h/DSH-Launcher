import { contextBridge, ipcRenderer } from 'electron'
import type { DshLauncherApi, LauncherEvent } from '../shared/types'

const api: DshLauncherApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  startInstance: (instanceId) => ipcRenderer.invoke('harness:start', instanceId),
  stopInstance: (instanceId) => ipcRenderer.invoke('harness:stop', instanceId),
  restartInstance: (instanceId) => ipcRenderer.invoke('harness:restart', instanceId),
  setActiveInstance: (instanceId) => ipcRenderer.invoke('instances:setActive', instanceId),
  addInstance: (input) => ipcRenderer.invoke('instances:add', input),
  updateInstance: (instanceId, patch) => ipcRenderer.invoke('instances:update', instanceId, patch),
  removeInstance: (instanceId) => ipcRenderer.invoke('instances:remove', instanceId),
  openUi: (instanceId) => ipcRenderer.invoke('harness:openUi', instanceId),
  openInstanceWindow: (instanceId) => ipcRenderer.invoke('harness:openInstanceWindow', instanceId),
  closeInstanceWindow: (instanceId) => ipcRenderer.invoke('harness:closeInstanceWindow', instanceId),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  listPluginMatrix: () => ipcRenderer.invoke('plugins:listMatrix'),
  setPluginMeta: (name, meta) => ipcRenderer.invoke('plugins:setMeta', name, meta),
  installPlugin: (instanceId, spec, name) => ipcRenderer.invoke('plugins:install', instanceId, spec, name),
  disablePlugin: (instanceId, name) => ipcRenderer.invoke('plugins:disable', instanceId, name),
  updatePlugin: (instanceId, name) => ipcRenderer.invoke('plugins:update', instanceId, name),
  removeFromLibrary: (name) => ipcRenderer.invoke('plugins:removeFromLibrary', name),
  removeFromLibraryMany: (names) => ipcRenderer.invoke('plugins:removeFromLibraryMany', names),
  repairDeps: () => ipcRenderer.invoke('build:repair'),
  rebuild: () => ipcRenderer.invoke('build:rebuild'),
  downloadHarness: () => ipcRenderer.invoke('download:harness'),
  downloadPlugin: (url, subdir, instanceId) => ipcRenderer.invoke('download:plugin', url, subdir, instanceId),
  installBundle: (bundleId, options) => ipcRenderer.invoke('bundles:install', bundleId, options),
  installRuntime: () => ipcRenderer.invoke('runtime:install'),
  updateRuntime: () => ipcRenderer.invoke('runtime:update'),
  getBalance: () => ipcRenderer.invoke('balance:get'),
  searchMarket: (sourceId, page, query, categoryId, force) =>
    ipcRenderer.invoke('market:search', sourceId, page, query, categoryId, force),
  fetchMarketReadme: (owner, repo) => ipcRenderer.invoke('market:readme', owner, repo),
  confirmOpenExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  setDshActive: (instanceId, active, reload) => ipcRenderer.send('dsh:set-active', instanceId, active, reload),
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
