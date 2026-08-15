import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ApiPreset, LauncherConfig } from '../shared/types'

const home = homedir()

function firstExisting(candidates: string[]): string {
  return candidates.find(c => c && existsSync(resolve(c))) ?? candidates.find(c => c) ?? ''
}

const DEFAULT_API_PRESETS: ApiPreset[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    balanceUrl: 'https://api.deepseek.com/user/balance',
    apiKey: ''
  },
  {
    id: 'custom',
    name: '自定义 / 中转',
    baseUrl: '',
    balanceUrl: '',
    apiKey: ''
  }
]

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
    apiPresets: DEFAULT_API_PRESETS.map((p) => ({ ...p })),
    activeApiPresetId: 'deepseek-official',
    language: systemLang
  }
}

/** The currently active API preset; falls back to the first preset (or DeepSeek official). */
export function getActiveApiPreset(): ApiPreset {
  const cfg = getConfig()
  const presets = cfg.apiPresets ?? []
  return presets.find((p) => p.id === cfg.activeApiPresetId) ?? presets[0] ?? DEFAULT_API_PRESETS[0]
}

let cache: LauncherConfig | null = null
let configPath = ''

function file(): string {
  if (!configPath) configPath = join(app.getPath('userData'), 'launcher-config.json')
  return configPath
}

export function getConfig(): LauncherConfig {
  if (cache) return cache
  try {
    const raw = readFileSync(file(), 'utf8')
    cache = { ...defaults(), ...(JSON.parse(raw) as Partial<LauncherConfig>) }
  } catch {
    cache = defaults()
  }
  return cache
}

export function setConfig(patch: Partial<LauncherConfig>): LauncherConfig {
  const next = { ...getConfig(), ...patch }
  cache = next
  try {
    const dir = dirname(file())
    mkdirSync(dir, { recursive: true })
    writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('failed to persist launcher config:', err)
  }
  return next
}
