import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { LauncherConfig } from '../shared/types'

const home = homedir()

function firstExisting(candidates: string[]): string {
  return candidates.find(c => c && existsSync(resolve(c))) ?? candidates.find(c => c) ?? ''
}

function defaults(): LauncherConfig {
  return {
    harnessRepo: firstExisting([process.env.DSH_REPO ?? '', join(home, 'deepseek-harness')]),
    dshHome: firstExisting([process.env.DSH_HOME ?? '', join(home, '.dsh')]),
    pluginDir: firstExisting([join(home, 'DSH-Plugin')]),
    profile: 'web',
    port: 3080,
    nodePath: 'node',
    launchArgs: ['apps/cli/lib/bin.js'],
    buildCmd: 'pnpm run build',
    stopOnQuit: true,
    pnpm: 'pnpm',
    autoOpenUi: true,
    startupTimeoutMs: 90000
  }
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
