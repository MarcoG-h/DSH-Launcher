import { dialog, ipcMain, shell } from 'electron'
import * as balance from './balance'
import { broadcast } from './bus'
import { getConfig, setConfig } from './config'
import { t } from './i18n'
import * as dshview from './dshview'
import * as harness from './harness'
import * as instances from './instances'
import * as orb from './orb'
import * as market from './market'
import * as plugins from './plugins'
import * as popup from './popup'
import * as runtime from './runtime'
import { registerEmbeddedView } from './webview'
import type { DshInstance, MarketSourceId, NewInstanceInput, PluginMeta } from '../shared/types'

/** Broadcast the instance list so the renderer and tray light stay in sync. */
function broadcastInstances(): void {
  const cfg = getConfig()
  broadcast({ type: 'instances', instances: cfg.instances, activeInstanceId: cfg.activeInstanceId })
}

export function registerIpc(): void {
  registerEmbeddedView()
  ipcMain.handle('state:get', () => ({
    states: harness.getAllStates(),
    logs: harness.getAllLogs(),
    config: getConfig()
  }))

  // --- instance lifecycle ---
  ipcMain.handle('harness:start', (_e, instanceId: string) => harness.startInstance(String(instanceId)))
  ipcMain.handle('harness:stop', (_e, instanceId: string) => harness.stopInstance(String(instanceId)))
  ipcMain.handle('harness:restart', (_e, instanceId: string) => harness.restartInstance(String(instanceId)))
  ipcMain.handle('harness:openUi', (_e, instanceId: string) => {
    // Renderer calls with no argument to open whatever is active.
    const id = String(instanceId || instances.getActiveInstance().id)
    const port = harness.getState(id).port
    if (port <= 0) return false
    return shell.openExternal(`http://127.0.0.1:${port}`)
  })
  ipcMain.handle('harness:openInstanceWindow', (_e, instanceId: string) => {
    // Open (or focus) the instance's DSH UI in a launcher child window.
    popup.openInstanceWindow(String(instanceId || instances.getActiveInstance().id))
    return true
  })
  ipcMain.handle('harness:closeInstanceWindow', (_e, instanceId: string) => {
    // Close the instance's separate window, returning it to the embedded view.
    popup.closeInstanceWindow(String(instanceId || instances.getActiveInstance().id))
    return true
  })

  // --- instance management ---
  ipcMain.handle('instances:setActive', (_e, id: string) => {
    const cfg = instances.setActiveInstance(String(id))
    broadcastInstances()
    return cfg
  })
  ipcMain.handle('instances:add', async (_e, input: NewInstanceInput) => {
    const cfg = await instances.addInstance(input)
    broadcastInstances()
    return cfg
  })
  ipcMain.handle('instances:update', (_e, id: string, patch: Partial<DshInstance>) => {
    const cfg = instances.updateInstance(String(id), patch)
    broadcastInstances()
    return cfg
  })
  ipcMain.handle('instances:remove', async (_e, id: string) => {
    await harness.stopInstance(String(id))
    const cfg = await instances.removeInstance(String(id))
    // 同时清理该实例的嵌入式视图(隐藏的 WebContents 泄漏)。
    dshview.removeDshView(String(id))
    broadcastInstances()
    return cfg
  })

  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', (_e, patch: Partial<typeof getConfig>) => setConfig(patch))

  // --- plugins (scoped to one instance's profile) ---
  ipcMain.handle('plugins:list', () => plugins.listPlugins())
  ipcMain.handle('plugins:listMatrix', () => plugins.listPluginMatrix())
  ipcMain.handle('plugins:setMeta', (_e, name: string, meta: PluginMeta) => {
    plugins.setPluginMeta(String(name), meta)
    return true
  })

  /** 实例的 { home, profile }:独立 home(inst.dshHome)或共享 home;兜底取配置镜像。 */
  const profileFor = (instanceId: string): { home: string; profile: string } => {
    const inst = instances.getInstance(String(instanceId))
    if (inst) return { home: instances.instanceDshHome(inst), profile: inst.profile }
    const cfg = getConfig()
    return { home: cfg.dshHome, profile: cfg.profile }
  }

  // A plugin-set change (install / remove / toggle) only takes effect once dsh
  // re-reads its profile manifest on next boot. We do NOT auto-restart: instead
  // the affected running instances are marked as awaiting a manual restart (the
  // sidebar shows them yellow with a "plugin changes" hint). Skipped when the
  // instance isn't running — the change is simply picked up on next start.
  const markPendingRestart = (instanceId: string, applied: boolean): void => {
    if (!applied || !instanceId) return
    harness.markPendingRestart(String(instanceId))
  }

  ipcMain.handle('plugins:install', async (_e, instanceId: string, spec: string, name?: string) => {
    // 写操作前兜底确保 home 物理存在(独立 home 被外部删除时重建空目录,避免神秘报错)
    const inst = instances.getInstance(String(instanceId))
    if (inst) instances.ensureInstanceHome(inst)
    const { home, profile } = profileFor(String(instanceId))
    const r = await plugins.install(home, profile, String(spec), name == null ? undefined : String(name))
    markPendingRestart(String(instanceId), r.ok)
    return r
  })
  ipcMain.handle('plugins:disable', async (_e, instanceId: string, name: string) => {
    const { home, profile } = profileFor(String(instanceId))
    const r = await plugins.disable(home, profile, String(name))
    markPendingRestart(String(instanceId), r.ok)
    return r
  })
  ipcMain.handle('plugins:update', async (_e, instanceId: string, name: string) => {
    const { home, profile } = profileFor(String(instanceId))
    const r = await plugins.update(home, profile, String(name))
    markPendingRestart(String(instanceId), r.ok)
    return r
  })
  ipcMain.handle('plugins:removeFromLibrary', async (_e, name: string) => {
    const r = await plugins.removeFromLibrary(String(name))
    for (const id of r.affected ?? []) harness.markPendingRestart(id)
    return r
  })
  ipcMain.handle('plugins:removeFromLibraryMany', async (_e, names: string[]) => {
    const list = (Array.isArray(names) ? names : []).map(String)
    const r = await plugins.removeFromLibraryMany(list)
    for (const id of r.affected ?? []) harness.markPendingRestart(id)
    return r
  })
  ipcMain.handle('bundles:install', (_e, bundleId: string, options?: { retrySpecs?: string[]; homeMode?: 'shared' | 'isolated'; home?: string }) => {
    const o = options ?? {}
    return plugins.installBundle(String(bundleId), {
      ...(Array.isArray(o.retrySpecs) ? { retrySpecs: o.retrySpecs.map(String) } : {}),
      ...(o.homeMode === 'shared' || o.homeMode === 'isolated'
        ? { homeMode: o.homeMode, home: o.homeMode === 'shared' ? String(o.home ?? '') : undefined }
        : {})
    })
  })

  ipcMain.handle('build:repair', () => plugins.repairDeps())
  ipcMain.handle('build:rebuild', () => plugins.rebuild())
  ipcMain.handle('download:harness', () => plugins.downloadHarness())
  // Download to the shared library only — no install, no enable, no restart.
  ipcMain.handle('download:plugin', async (_e, url: string, subdir?: string, instanceId?: string) => {
    return plugins.downloadPlugin(String(url), subdir == null ? undefined : String(subdir), profileFor(String(instanceId)).profile)
  })

  // Install/upgrade of the portable runtime must not race a running harness
  // (npm writes the files the bundled dsh is executing).
  const busyGuard = (fn: () => Promise<{ ok: boolean }>): (() => Promise<{ ok: boolean; code: number | null; error?: string }>) => {
    return async () => {
      const anyRunning = Object.values(harness.getAllStates()).some((s) => s.status === 'running' || s.status === 'starting' || s.status === 'stopping')
      if (anyRunning) {
        return { ok: false, code: null, error: t('请先停止 dsh,再安装 / 更新运行环境。', 'Stop dsh first, then install / update the runtime.') }
      }
      return (await fn()) as { ok: boolean; code: number | null; error?: string }
    }
  }
  ipcMain.handle('runtime:install', busyGuard(runtime.installRuntime))
  ipcMain.handle('runtime:update', busyGuard(async () => {
    // 更新前检测运行中的实例:正在被使用的 dsh 文件(在 .dsh-runtime 下)替换会被
    // 进程占用而失败,也可能让运行中的实例崩溃。UI 会先弹窗自动停止,这里是兜底。
    for (const inst of instances.getInstances()) {
      const st = harness.getState(inst.id)
      if (st.status === 'running' || st.status === 'external') {
        return { ok: false, code: 1, error: t(`实例「${inst.name}」正在运行 — 请先关闭所有实例再更新 dsh`, `Instance "${inst.name}" is running — stop all instances before updating dsh`) }
      }
    }
    return runtime.updateRuntime()
  }))

  ipcMain.handle('balance:get', () => balance.getBalance())

  // Plugin market (GitHub search, unauthenticated).
  ipcMain.handle('market:search', (_e, sourceId: string, page: number, query?: string, categoryId?: string, force?: boolean) =>
    market.searchMarket((sourceId as MarketSourceId) || 'github', page, query, categoryId, Boolean(force)))
  ipcMain.handle('market:readme', (_e, owner: string, repo: string) => market.fetchReadme(String(owner), String(repo)))

  // External links inside the market README: confirm with a native dialog, then
  // open via the system browser. Never navigates the launcher window itself.
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    const u = String(url ?? '')
    if (!/^(https?:|mailto:)/i.test(u)) return false
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: [t('打开', 'Open'), t('取消', 'Cancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: t('用浏览器打开外部链接?', 'Open external link in browser?'),
      detail: u
    })
    if (response !== 0) return false
    await shell.openExternal(u)
    return true
  })

  // Embedded DSH view (native WebContentsView) — bounds follow the sidebar.
  ipcMain.on('dsh:set-active', (_e, instanceId: string, active: boolean, reload?: boolean) =>
    dshview.setDshActive(String(instanceId), Boolean(active), Boolean(reload))
  )
  ipcMain.on('dsh:set-sidebar-width', (_e, width: number) => dshview.setDshSidebarWidth(Number(width)))

  // Floating whale orb (a small view over the DSH view) — events come from the
  // dedicated orb page (`?orb=1`); `orb:clicked` goes back to the launcher.
  ipcMain.on('orb:set-visible', (_e, visible: boolean) => orb.setOrbVisible(Boolean(visible)))
  ipcMain.on('orb:drag-start', (_e, ox: number, oy: number) => orb.orbDragStart(Number(ox), Number(oy)))
  ipcMain.on('orb:drag-move', (_e, sx: number, sy: number) => orb.orbDragMove(Number(sx), Number(sy)))
  ipcMain.on('orb:drag-end', () => orb.orbDragEnd())
  ipcMain.on('orb:click', () => orb.orbClick())
}
