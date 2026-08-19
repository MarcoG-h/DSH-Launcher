import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DshInstance, LauncherConfig } from '../shared/types'

const home = homedir()

function firstExisting(candidates: string[]): string {
  return candidates.find(c => c && existsSync(resolve(c))) ?? candidates.find(c => c) ?? ''
}

function defaults(): LauncherConfig {
  const harnessRepo = firstExisting([process.env.DSH_REPO ?? '', join(home, 'deepseek-harness')])
  const runtimeRoot = join(home, '.dsh-runtime')
  const systemLang = (app.getLocale() ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return {
    // A checked-out repo implies we're on the developer machine ⇒ source mode.
    // Anything else targets the portable runtime (sharing the launcher to others).
    installMode: existsSync(harnessRepo) ? 'source' : 'bundled',
    runtimeRoot,
    nodeVersion: '22.20.0',
    dshVersion: '0.1.0-rc.6',
    harnessRepo,
    harnessRepoUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
    dshHome: firstExisting([process.env.DSH_HOME ?? '', join(home, '.dsh')]),
    pluginDir: firstExisting([join(home, 'DSH-Plugin')]),
    profile: 'web',
    port: 3080,
    nodePath: 'node',
    launchArgs: ['apps/cli/lib/bin.js'],
    buildCmd: 'pnpm run build',
    stopOnQuit: true,
    pnpm: 'pnpm',
    startupTimeoutMs: 90000,
    language: systemLang,
    closeToTray: true,
    splashEnabled: true,
    autoStartOnLaunch: false,
    floatingWhale: false,
    marketPageSize: 30,
    marketSource: 'github',
    githubToken: '',
    instances: [],
    activeInstanceId: '',
    pluginMeta: {}
  }
}

/**
 * Multi-instance migration + mirror sync. `profile` / `port` / `autoStartOnLaunch`
 * are kept as mirrors of the *active* instance so all pre-instance code paths
 * (and the legacy Settings fields) keep reading the right values.
 *
 * A config with no `instances` is a legacy single-install config: it is turned
 * into one default instance whose workspace is *not* pinned, so
 * {@link resolveWorkspace} keeps returning the historical cwd (harness repo in
 * source mode, runtime root in bundled mode) and existing sessions stay put.
 */
function reconcileInstances(cfg: LauncherConfig): LauncherConfig {
  let instances = cfg.instances ?? []
  let activeInstanceId = cfg.activeInstanceId ?? ''
  if (instances.length === 0) {
    const id = 'default'
    const legacy: DshInstance = {
      id,
      name: cfg.language === 'en' ? 'Default' : '默认实例',
      profile: cfg.profile || 'web',
      port: cfg.port || 3080,
      autoStart: cfg.autoStartOnLaunch ?? false,
      description: '',
      enabled: true
      // workspace left undefined → resolveWorkspace falls back to the legacy cwd
    }
    instances = [legacy]
    activeInstanceId = id
  }
  // Backfill the newer fields so instances written before `description` /
  // `enabled` existed keep working: enabled defaults on, description empty.
  instances = instances.map(i => ({
    ...i,
    description: i.description ?? '',
    enabled: i.enabled !== false
  }))
  const active = instances.find(i => i.id === activeInstanceId)
  if (!active || active.enabled === false) {
    // Never leave the active instance hidden — fall back to the first shown one.
    activeInstanceId = (instances.find(i => i.enabled !== false) ?? instances[0]).id
  }
  const target = instances.find(i => i.id === activeInstanceId) ?? instances[0]
  return {
    ...cfg,
    instances,
    activeInstanceId,
    profile: target.profile,
    port: target.port,
    autoStartOnLaunch: target.autoStart
  }
}

/** Folds a mirror edit (profile/port/autoStartOnLaunch) back into the active instance. */
function reconcileMirrors(cfg: LauncherConfig): LauncherConfig {
  const active = cfg.instances.find(i => i.id === cfg.activeInstanceId) ?? cfg.instances[0]
  if (!active) return cfg
  const instances = cfg.instances.map(i =>
    i.id === active.id ? { ...i, profile: cfg.profile, port: cfg.port, autoStart: cfg.autoStartOnLaunch } : i
  )
  return { ...cfg, instances }
}

let cache: LauncherConfig | null = null
let configPath = ''

function file(): string {
  if (!configPath) configPath = join(app.getPath('userData'), 'launcher-config.json')
  return configPath
}

function persist(cfg: LauncherConfig): void {
  try {
    const dir = dirname(file())
    mkdirSync(dir, { recursive: true })
    writeFileSync(file(), JSON.stringify(cfg, null, 2), 'utf8')
  } catch (err) {
    console.error('failed to persist launcher config:', err)
  }
}

export function getConfig(): LauncherConfig {
  if (cache) return cache
  try {
    const raw = readFileSync(file(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LauncherConfig>
    cache = reconcileInstances({ ...defaults(), ...parsed })
    // Persist the one-time migration so `instances` is stable on disk.
    if (!Array.isArray(parsed.instances) || parsed.instances.length === 0) {
      persist(cache)
    }
  } catch {
    cache = reconcileInstances(defaults())
  }
  return cache
}

export function setConfig(patch: Partial<LauncherConfig>): LauncherConfig {
  let next = { ...getConfig(), ...patch }
  if (next.instances.length === 0) {
    // Guard against a caller wiping the instance list — re-derive the default.
    next = reconcileInstances(next)
  } else if (patch.instances || patch.activeInstanceId) {
    // The instance list / active id changed directly → re-sync the mirrors.
    next = reconcileInstances(next)
  } else if (patch.profile !== undefined || patch.port !== undefined || patch.autoStartOnLaunch !== undefined) {
    // A legacy mirror field changed → fold it back into the active instance.
    next = reconcileMirrors(next)
  }
  cache = next
  persist(next)
  return next
}
