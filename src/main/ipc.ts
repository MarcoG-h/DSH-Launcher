import { dialog, ipcMain, shell } from 'electron'
import * as balance from './balance'
import { getConfig, setConfig } from './config'
import { t } from './i18n'
import * as dshview from './dshview'
import * as harness from './harness'
import * as orb from './orb'
import * as market from './market'
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
  ipcMain.handle('download:plugin', (_e, url: string, subdir?: string) => plugins.downloadPlugin(String(url), subdir == null ? undefined : String(subdir)))

  // Install/upgrade of the portable runtime must not race a running harness
  // (npm writes the files the bundled dsh is executing).
  const busyGuard = (fn: () => Promise<{ ok: boolean }>): (() => Promise<{ ok: boolean; code: number | null; error?: string }>) => {
    return async () => {
      const st = harness.getState().status
      if (st === 'running' || st === 'starting' || st === 'stopping') {
        return { ok: false, code: null, error: t('请先停止 dsh,再安装 / 更新运行环境。', 'Stop dsh first, then install / update the runtime.') }
      }
      return (await fn()) as { ok: boolean; code: number | null; error?: string }
    }
  }
  ipcMain.handle('runtime:install', busyGuard(runtime.installRuntime))
  ipcMain.handle('runtime:update', busyGuard(runtime.updateRuntime))

  ipcMain.handle('balance:get', () => balance.getBalance())

  // Plugin market (GitHub search, unauthenticated).
  ipcMain.handle('market:search', (_e, page: number, query?: string) => market.searchMarket(page, query))
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
  ipcMain.on('dsh:set-active', (_e, active: boolean, reload?: boolean) =>
    dshview.setDshActive(Boolean(active), Boolean(reload))
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
