import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getConfig } from './config'
import { broadcast } from './bus'
import type { CmdResult, InstalledPlugin, LocalPlugin, LocalStatus, PluginListResult } from '../shared/types'

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function profileDir(profile: string): string {
  return join(getConfig().dshHome, 'profiles', profile)
}

/** Stream a child process and broadcast its output as a task. */
function runAsync(cmd: string, args: string[], cwd: string, label: string, useShell: boolean): Promise<CmdResult> {
  return new Promise((resolve) => {
    broadcast({ type: 'task', task: { label, status: 'start', code: null } })
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        shell: useShell,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0' }
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      broadcast({ type: 'task', task: { label, status: 'end', code: null } })
      resolve({ ok: false, code: null, error })
      return
    }
    const emit = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').replace(ANSI, '').split(/\r?\n/)) {
        if (line.trim()) broadcast({ type: 'task', task: { label, status: 'start', code: null, stream, line } })
      }
    }
    child.stdout?.on('data', emit('stdout'))
    child.stderr?.on('data', emit('stderr'))
    child.on('error', (err) => {
      broadcast({ type: 'task', task: { label, status: 'end', code: null } })
      resolve({ ok: false, code: null, error: err.message })
    })
    child.on('close', (code) => {
      broadcast({ type: 'task', task: { label, status: 'end', code } })
      resolve({ ok: code === 0, code })
    })
  })
}

function pnpmCmd(args: string[], cwd: string, label: string): Promise<CmdResult> {
  const cfg = getConfig()
  return runAsync(cfg.pnpm, args, cwd, label, process.platform === 'win32')
}

function dshPluginCmd(profile: string, extra: string[]): { cmd: string; args: string[]; cwd: string } {
  const cfg = getConfig()
  return {
    cmd: cfg.nodePath,
    args: [...cfg.launchArgs, 'plugin', '--profile', profile, ...extra],
    cwd: cfg.harnessRepo
  }
}

// --- reads ---

export function listInstalled(profile: string): { installed: InstalledPlugin[]; bundles: string[] } {
  const dir = profileDir(profile)
  const manifest = readJson(join(dir, 'package.json'))
  const deps = (manifest?.dependencies as Record<string, string> | undefined) ?? {}
  const dsh = manifest?.dsh as Record<string, unknown> | undefined
  const profileBlock = dsh?.profile as Record<string, unknown> | undefined
  const bundles: string[] = Array.isArray(profileBlock?.bundles) ? (profileBlock.bundles as string[]) : []

  const installed: InstalledPlugin[] = []
  for (const [name, specRaw] of Object.entries(deps)) {
    const spec = String(specRaw)
    const pkgPath = join(dir, 'node_modules', name, 'package.json')
    let version = ''
    let description = ''
    let isBundle = false
    let localPath: string | null = null
    try {
      const pkg = readJson(realpathSync(pkgPath)) ?? {}
      version = String(pkg.version ?? '')
      description = String(pkg.description ?? '')
      isBundle = Boolean((pkg.dsh as Record<string, unknown> | undefined)?.bundle)
    } catch {
      /* uninstalled / broken — show with empty metadata */
    }
    if (spec.startsWith('file:')) {
      const p = spec.slice('file:'.length)
      try {
        localPath = realpathSync(resolve(dir, p))
      } catch {
        localPath = resolve(dir, p)
      }
    }
    installed.push({
      name,
      version,
      description,
      spec,
      localPath,
      enabled: bundles.includes(name),
      isBundle,
      inBox: false
    })
  }
  return { installed, bundles }
}

export function listLocal(): LocalPlugin[] {
  const cfg = getConfig()
  const { installed } = listInstalled(cfg.profile)
  const names = new Map<string, LocalStatus>(installed.map((p) => [p.name, p.enabled ? 'enabled' : 'installed']))
  const out: LocalPlugin[] = []
  if (!existsSync(cfg.pluginDir)) return out
  for (const entry of readdirSync(cfg.pluginDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkg = readJson(join(cfg.pluginDir, entry.name, 'package.json'))
    if (!pkg?.name) continue
    const name = String(pkg.name)
    out.push({
      name,
      version: String(pkg.version ?? ''),
      description: String(pkg.description ?? ''),
      path: join(cfg.pluginDir, entry.name),
      isBundle: Boolean((pkg.dsh as Record<string, unknown> | undefined)?.bundle),
      platform: String(((pkg.dsh as Record<string, unknown> | undefined)?.client as Record<string, unknown> | undefined)?.platform ?? '') || null,
      status: names.get(name) ?? 'not-installed'
    })
  }
  return out
}

export function listPlugins(): PluginListResult {
  const cfg = getConfig()
  const { installed, bundles } = listInstalled(cfg.profile)
  return { profile: cfg.profile, bundles, installed, local: listLocal() }
}

// --- mutations ---

/** Install a plugin (local path or npm spec) into a profile via `dsh plugin add`. */
export async function install(profile: string, spec: string): Promise<CmdResult> {
  const target = /^\.{1,2}[/\\]/.test(spec) ? resolve(process.cwd(), spec) : spec
  const { cmd, args, cwd } = dshPluginCmd(profile, ['add', target])
  return runAsync(cmd, args, cwd, `install:${target}`, process.platform === 'win32')
}

export async function remove(profile: string, name: string): Promise<CmdResult> {
  const { cmd, args, cwd } = dshPluginCmd(profile, ['remove', name])
  return runAsync(cmd, args, cwd, `remove:${name}`, process.platform === 'win32')
}

/** Toggle a bundle in the profile manifest without touching the installed dependency. */
export function setEnabled(profile: string, name: string, enabled: boolean): { ok: boolean; changed: boolean; bundles: string[] } {
  const dir = profileDir(profile)
  const mp = join(dir, 'package.json')
  const manifest = readJson(mp) ?? {}
  const dsh = (manifest.dsh as Record<string, unknown> | undefined) ?? {}
  const profileBlock = (dsh.profile as Record<string, unknown> | undefined) ?? {}
  const bundles = new Set((profileBlock.bundles as string[] | undefined) ?? [])

  let changed = false
  if (enabled && !bundles.has(name)) {
    bundles.add(name)
    changed = true
  } else if (!enabled && bundles.has(name)) {
    bundles.delete(name)
    changed = true
  }
  const list = [...bundles]
  if (changed) {
    const next = { ...manifest, dsh: { ...dsh, profile: { ...profileBlock, bundles: list } } }
    writeFileSync(mp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  }
  return { ok: true, changed, bundles: list }
}

// --- maintenance ---

/** `pnpm install` in the harness repo — repairs missing deps like zod. */
export function repairDeps(): Promise<CmdResult> {
  return pnpmCmd(['install'], getConfig().harnessRepo, 'repair')
}

/** Run the configured build command (default `pnpm run build`) in the harness repo. */
export function rebuild(): Promise<CmdResult> {
  const cfg = getConfig()
  const tokens = cfg.buildCmd.trim().split(/\s+/)
  const cmd = tokens[0] ?? 'pnpm'
  const args = tokens.slice(1)
  return runAsync(cmd, args, cfg.harnessRepo, 'build', process.platform === 'win32')
}
