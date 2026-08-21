import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { api, type LauncherConfig } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { MARKET_SOURCES } from '../../../shared/plugin-sources'
import type { MarketSourceId } from '../../../shared/types'
import { TaskConsole } from '../components/TaskConsole'
import { Toggle } from '../components/Toggle'
import { DownloadIcon, RefreshIcon, PowerIcon } from '../lib/icons'
import whaleIcon from '../assets/whale.png'
import rueIcon from '../assets/rue.png'
import proto1Icon from '../assets/proto1.png'
import cedricIcon from '../assets/cedric.png'

function Field({ label, value, onChange, mono = true, hint }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; hint?: string }): JSX.Element {
  return (
    <div>
      <label className="label">{label}</label>
      <input className={`input ${mono ? 'mono' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>{hint}</p>
      )}
    </div>
  )
}

export function Settings(): JSX.Element {
  const { config, saveConfig, tasks, refresh, dshUpdate, states, instances } = useHarness()
  const { t, lang } = useI18n()
  const [tab, setTab] = useState<'dsh' | 'system'>('dsh')
  const [form, setForm] = useState<Partial<LauncherConfig>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [dlBusy, setDlBusy] = useState(false)
  const [dlDone, setDlDone] = useState(false)
  const [rtBusy, setRtBusy] = useState<'install' | 'update' | null>(null)
  const [rtDone, setRtDone] = useState(false)

  useEffect(() => {
    if (config) {
      setForm((f) => ({ ...f, ...config }))
    }
  }, [config])

  const set = (k: keyof LauncherConfig) => (v: string | number | boolean | string[]) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (tab === 'system') {
      // System settings persist on every change — no Save button to forget
      // (checked a box at the top and left without saving was easy to do).
      void saveConfig({ [k]: v } as Partial<LauncherConfig>)
    }
  }

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const doDownload = async (): Promise<void> => {
    setDlBusy(true)
    setDlDone(false)
    try {
      const r = await api.downloadHarness()
      await refresh() // pull the auto-configured paths into the form
      setDlDone(r.ok)
    } finally {
      setDlBusy(false)
    }
  }

  const doInstallRuntime = async (): Promise<void> => {
    setRtBusy('install')
    setRtDone(false)
    try {
      const r = await api.installRuntime()
      await refresh()
      setRtDone(r.ok)
      if (r.ok) {
        // Deployment complete ⇒ from now on auto-start dsh on launch (the box
        // reflects the new value after config propagates back into the form).
        await saveConfig({ autoStartOnLaunch: true })
      }
    } finally {
      setRtBusy(null)
    }
  }

  const doUpdateDsh = async (): Promise<void> => {
    setRtBusy('update')
    try {
      // 更新 dsh 前检测运行中的实例:弹窗确认,确认后自动关闭再更新。
      // bundled → 更新内置 dsh;source → 拉取源码版最新(git pull)。
      const running = instances.filter((inst) => {
        const st = states[inst.id]?.status
        return st === 'running' || st === 'external'
      })
      if (running.length > 0) {
        const ok = window.confirm(t('settings.updateCloseInstancesConfirm', { count: running.length }))
        if (!ok) return
        for (const inst of running) await api.stopInstance(inst.id)
      }
      const r = isBundled ? await api.updateRuntime() : await api.downloadHarness()
      await refresh()
      setRtDone(r.ok)
    } finally {
      setRtBusy(null)
    }
  }

  const isBundled = form.installMode === 'bundled'
  const downloadTask = tasks['download:harness']
  const repairTask = tasks['repair']
  const buildTask = tasks['build']
  const runtimeTask = tasks['runtime:install']
  const updateTask = tasks['runtime:update']

  return (
    <div className="p-5 space-y-5 max-w-[900px]">
      <h2 className="text-[18px] font-semibold">{t('settings.title')}</h2>

      {/* tab bar — click to jump straight to the section */}
      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {(['dsh', 'system'] as const).map((k) => (
          <button
            key={k}
            className="border-b-2 px-3 pb-2 text-[13px] font-medium transition-colors"
            style={{
              color: tab === k ? 'var(--accent)' : 'var(--muted)',
              borderColor: tab === k ? 'var(--accent)' : 'transparent'
            }}
            onClick={() => setTab(k)}
          >
            {k === 'dsh' ? t('settings.dshTitle') : t('settings.systemTitle')}
          </button>
        ))}
      </div>

      {tab === 'dsh' && (
      <section className="space-y-4">
        {/* Quick offline deployment (bundled runtime) */}
        <div className="panel p-5 space-y-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 space-y-1">
              <h3 className="section-title">{t('settings.offlineTitle')}</h3>
              <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                {t('settings.offlineDesc.pre')}<span className="mono">@deepseek-ai/dsh</span>{t('settings.offlineDesc.mid')}
                <strong style={{ color: 'var(--text)' }}>{t('settings.offlineDesc.bold')}</strong>{t('settings.offlineDesc.tail')}
              </p>
              <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                {t('settings.currentMode')}
                <span
                  className="badge ml-2"
                  style={
                    isBundled
                      ? { color: 'var(--accent)', background: 'var(--accent-soft)' }
                      : { color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }
                  }
                >
                  {isBundled ? t('settings.modeBundled') : t('settings.modeSource')}
                </span>
              </p>
              <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                {t('settings.updateNote.pre')} <span className="mono">~/.dsh</span> {t('settings.updateNote.mid')}
                <span className="mono"> cordis.patch.yml</span> {t('settings.updateNote.tail')}
              </p>
              {dshUpdate?.latest && (
                <p
                  className="text-[12.5px] leading-relaxed"
                  style={{ color: dshUpdate.update && dshUpdate.current ? 'var(--warn)' : 'var(--muted)' }}
                >
                  {dshUpdate.update && dshUpdate.current
                    ? t('settings.dshUpdateAvailable', { latest: dshUpdate.latest, current: dshUpdate.current })
                    : t('settings.dshUpToDate', { latest: dshUpdate.latest })}
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button className="btn btn-primary shrink-0" disabled={rtBusy !== null} onClick={() => void doInstallRuntime()}>
                <DownloadIcon /> {rtBusy === 'install' ? t('settings.deploying') : t('settings.deployBtn')}
              </button>
              <button className="btn btn-ghost shrink-0" disabled={rtBusy !== null} onClick={() => void doUpdateDsh()}>
                <RefreshIcon /> {rtBusy === 'update' ? t('settings.updating') : (isBundled ? t('settings.updateBtn') : t('settings.updateSourceBtn'))}
              </button>
            </div>
          </div>
          {rtDone && (
            <p className="text-[12.5px]" style={{ color: 'var(--ok)' }}>
              {t('settings.deployDone')}
            </p>
          )}
          {runtimeTask && <TaskConsole task={runtimeTask} />}
          {updateTask && <TaskConsole task={updateTask} />}
          <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            {t('settings.diskNote')}
            <span className="mono"> {form.runtimeRoot || '—'}</span>
          </p>
        </div>

        {/* Source-mode download — advanced, kept small */}
        <details className="panel p-4 space-y-3">
          <summary
            className="cursor-pointer select-none text-[12px] font-medium"
            style={{ color: 'var(--muted)' }}
          >
            {t('settings.sourceTitle')}
          </summary>
          <p className="select-text text-[12px] leading-relaxed" style={{ color: 'var(--warn)' }}>
            {t('settings.sourceDesc')}
          </p>
          <p className="text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            {t('settings.sourceDesc2.pre')} <span className="mono">{form.harnessRepoUrl}</span> {t('settings.sourceDesc2.to')}{' '}
            <span className="mono">{form.harnessRepo}</span> {t('settings.sourceDesc2.mid')} <span className="mono">git pull</span> + <span className="mono">pnpm install</span>{t('settings.sourceDesc2.tail')}
          </p>
          <button className="btn btn-ghost btn-sm" disabled={dlBusy} onClick={() => void doDownload()}>
            <DownloadIcon /> {dlBusy ? t('settings.downloading') : t('settings.downloadBtn')}
          </button>
          {dlDone && (
            <p className="text-[12px]" style={{ color: 'var(--ok)' }}>
              {t('settings.downloadDone')}
            </p>
          )}
          {downloadTask && <TaskConsole task={downloadTask} />}
          {repairTask && <TaskConsole task={repairTask} />}
        </details>

        {/* Maintenance — source mode only */}
        {!isBundled && (
          <div className="panel p-5 space-y-4">
            <h3 className="section-title">{t('settings.maintenanceTitle')}</h3>
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              {t('settings.maintenanceDesc.pre')} <span className="mono">zod</span>{t('settings.maintenanceDesc.tail')}
            </p>
            <div className="flex gap-2">
              <button className="btn btn-ghost" disabled={busy !== null} onClick={() => void run('repair', api.repairDeps)}>
                <RefreshIcon /> {t('settings.repair')}
              </button>
              <button className="btn btn-ghost" disabled={busy !== null} onClick={() => void run('build', api.rebuild)}>
                <PowerIcon /> {t('settings.rebuild')}
              </button>
            </div>
            {repairTask && (
              <div>
                <TaskConsole task={repairTask} />
              </div>
            )}
            {buildTask && (
              <div>
                <TaskConsole task={buildTask} />
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {tab === 'system' && (
      <section className="space-y-4">
        <div className="panel p-5 space-y-5">
          {/* app-level options */}
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">{t('settings.language')}</label>
              <select className="input" value={form.language ?? 'zh'} onChange={(e) => set('language')(e.target.value)}>
                <option value="zh">{t('settings.langZh')}</option>
                <option value="en">{t('settings.langEn')}</option>
              </select>
            </div>
            <div>
              <label className="label">{t('settings.marketPageSize')}</label>
              <input
                className="input mono"
                type="number"
                min={10}
                max={50}
                step={1}
                value={form.marketPageSize ?? 30}
                onChange={(e) => set('marketPageSize')(Number(e.target.value) || 30)}
              />
            </div>
            <div>
              <label className="label">{t('settings.marketSource')}</label>
              <select
                className="input"
                value={form.marketSource ?? 'github'}
                onChange={(e) => set('marketSource')(e.target.value as MarketSourceId)}
              >
                {MARKET_SOURCES.map((src) => (
                  <option key={src.id} value={src.id}>
                    {lang === 'zh' ? src.zhName : src.enName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">{t('settings.githubToken')}</label>
            <input
              className="input mono"
              type="password"
              value={form.githubToken ?? ''}
              placeholder="ghp_…"
              onChange={(e) => set('githubToken')(e.target.value)}
            />
            <p className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>{t('settings.githubTokenHint')}</p>
          </div>
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span>{t('settings.closeToTray')}</span>
            <Toggle checked={form.closeToTray ?? true} onChange={(v) => set('closeToTray')(v)} />
          </div>
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span>{t('settings.floatingWhale')}</span>
            <Toggle checked={form.floatingWhale ?? false} onChange={(v) => set('floatingWhale')(v)} />
          </div>
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span>{t('settings.splashEnabled')}</span>
            <Toggle checked={form.splashEnabled ?? true} onChange={(v) => set('splashEnabled')(v)} />
          </div>
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span>{t('settings.autoStartOnLaunch')}</span>
            <Toggle checked={form.autoStartOnLaunch ?? false} onChange={(v) => set('autoStartOnLaunch')(v)} />
          </div>

          {/* paths & launch */}
          <div className="space-y-4 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
            <h3 className="section-title">{t('settings.pathsTitle')}</h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="label">{t('settings.runMode')}</label>
                <select className="input" value={form.installMode ?? 'bundled'} onChange={(e) => set('installMode')(e.target.value)}>
                  <option value="bundled">{t('settings.modeOptionBundled')}</option>
                  <option value="source">{t('settings.modeOptionSource')}</option>
                </select>
              </div>
              <Field label={t('settings.runtimeRoot')} value={form.runtimeRoot ?? ''} onChange={set('runtimeRoot')} hint={t('settings.runtimeRootHint')} />
              <Field label={t('settings.harnessRepo')} value={form.harnessRepo ?? ''} onChange={set('harnessRepo')} hint={t('settings.harnessRepoHint')} />
              <Field label={t('settings.harnessRepoUrl')} value={form.harnessRepoUrl ?? ''} onChange={set('harnessRepoUrl')} hint={t('settings.harnessRepoUrlHint')} />
              <Field label={t('settings.dshHome')} value={form.dshHome ?? ''} onChange={set('dshHome')} hint={t('settings.dshHomeHint')} />
              <Field label={t('settings.pluginDir')} value={form.pluginDir ?? ''} onChange={set('pluginDir')} hint={t('settings.pluginDirHint')} />
              <div>
                <label className="label">{t('settings.port')}</label>
                <input className="input mono" type="number" value={form.port ?? 3080} onChange={(e) => set('port')(Number(e.target.value) || 3080)} />
              </div>
              <Field label={t('settings.profile')} value={form.profile ?? ''} onChange={set('profile')} hint={t('settings.profileHint')} />
              <Field label={t('settings.nodePath')} value={form.nodePath ?? ''} onChange={set('nodePath')} />
            </div>
            <Field
              label={t('settings.launchArgs')}
              value={(form.launchArgs ?? []).join(' ')}
              onChange={(v) => set('launchArgs')(v.split(/\s+/).filter(Boolean))}
              hint={`${t('settings.launchArgsHint')} ${form.nodePath ?? 'node'} ${[...(form.launchArgs ?? []), form.profile ?? 'web'].join(' ')}`}
            />
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label={t('settings.buildCmd')} value={form.buildCmd ?? ''} onChange={set('buildCmd')} />
              <Field label={t('settings.pnpm')} value={form.pnpm ?? ''} onChange={set('pnpm')} />
            </div>
            <div className="flex flex-wrap gap-6 pt-1">
              <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.stopOnQuit ?? true}
                  onChange={(e) => set('stopOnQuit')(e.target.checked)}
                />
                {t('settings.stopOnQuit')}
              </label>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="label">{t('settings.startupTimeout')}</label>
                <input
                  className="input mono"
                  type="number"
                  value={form.startupTimeoutMs ?? 90000}
                  onChange={(e) => set('startupTimeoutMs')(Number(e.target.value) || 90000)}
                />
              </div>
            </div>
          </div>

          <p className="pt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
            {t('settings.autoSavedHint')}
          </p>
        </div>
      </section>
      )}

      {/* app icon — above the author attribution */}
      <div className="flex justify-center pt-2 select-none">
        <img
          src={whaleIcon}
          alt="DSH Launcher"
          draggable={false}
          className="w-24 h-24 rounded-3xl object-cover border"
          style={{ background: '#fff', borderColor: 'rgba(128,128,128,0.25)' }}
        />
      </div>

      {/* author attribution — faint, with the three little character icons (no labels) */}
      <footer
        className="flex items-center justify-center gap-2 pt-2 select-none text-[10.5px]"
        style={{ color: 'var(--muted)', opacity: 0.55 }}
      >
        <span>by MarcoG-h</span>
        <img src={rueIcon} alt="rue" title="rue" className="h-4 w-4 rounded-full object-cover" draggable={false} />
        <img src={proto1Icon} alt="proto1" title="proto1" className="h-4 w-4 rounded-full object-cover" draggable={false} />
        <img src={cedricIcon} alt="credit" title="credit" className="h-4 w-4 rounded-full object-cover" draggable={false} />
      </footer>
    </div>
  )
}
