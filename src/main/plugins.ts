import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getConfig, setConfig } from './config'
import { t } from './i18n'
import { bundledEnv, resolveBundledNode } from './runtime'
import { runAsync, taskDone, taskLine } from './task'
import { parseGitHubUrl } from '../shared/github'
import type { CmdResult, InstalledPlugin, LocalPlugin, LocalStatus, PluginListResult } from '../shared/types'

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

function pnpmCmd(args: string[], cwd: string, label: string): Promise<CmdResult> {
  const cfg = getConfig()
  return runAsync(cfg.pnpm, args, cwd, label, process.platform === 'win32')
}

function dshPluginCmd(profile: string, extra: string[]): { cmd: string; args: string[]; cwd: string; envPatch?: NodeJS.ProcessEnv } {
  const cfg = getConfig()
  if (cfg.installMode === 'bundled') {
    // Run the bundled CLI; PATH is prefixed so its internal pnpm resolves to the portable copy.
    return {
      cmd: resolveBundledNode() ?? cfg.nodePath,
      args: [...cfg.launchArgs, 'plugin', '--profile', profile, ...extra],
      cwd: cfg.runtimeRoot,
      envPatch: bundledEnv()
    }
  }
  return {
    cmd: cfg.nodePath,
    args: [...cfg.launchArgs, 'plugin', '--profile', profile, ...extra],
    cwd: cfg.harnessRepo,
    envPatch: undefined
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
  const { cmd, args, cwd, envPatch } = dshPluginCmd(profile, ['add', target])
  return runAsync(cmd, args, cwd, `install:${target}`, process.platform === 'win32', envPatch)
}

export async function remove(profile: string, name: string): Promise<CmdResult> {
  const { cmd, args, cwd, envPatch } = dshPluginCmd(profile, ['remove', name])
  return runAsync(cmd, args, cwd, `remove:${name}`, process.platform === 'win32', envPatch)
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
  if (getConfig().installMode === 'bundled') {
    return Promise.resolve({ ok: false, code: 1, error: t('内置模式下无需修复源码依赖', 'No need to repair source deps in bundled mode') })
  }
  return pnpmCmd(['install'], getConfig().harnessRepo, 'repair')
}

/** Run the configured build command (default `pnpm run build`) in the harness repo. */
export function rebuild(): Promise<CmdResult> {
  const cfg = getConfig()
  if (cfg.installMode === 'bundled') {
    return Promise.resolve({ ok: false, code: 1, error: t('内置模式下无需重新构建源码', 'No need to rebuild the source in bundled mode') })
  }
  const tokens = cfg.buildCmd.trim().split(/\s+/)
  const cmd = tokens[0] ?? 'pnpm'
  const args = tokens.slice(1)
  return runAsync(cmd, args, cfg.harnessRepo, 'build', process.platform === 'win32')
}

// --- downloads ---

/**
 * One-click harness install: clone/update the repo, install deps, then
 * auto-configure the launcher's paths so it points at the downloaded repo.
 */
export async function downloadHarness(): Promise<CmdResult> {
  const cfg = getConfig()
  const url = cfg.harnessRepoUrl.trim() || 'https://github.com/deepseek-ai/deepseek-harness.git'
  const target = resolve(cfg.harnessRepo || join(homedir(), 'deepseek-harness'))
  const label = 'download:harness'

  const isGit = existsSync(join(target, '.git'))
  if (isGit) {
    const pull = await runAsync('git', ['-C', target, 'pull', '--ff-only'], process.cwd(), label, process.platform === 'win32')
    if (!pull.ok) taskLine(label, t('[download] 拉取未完成(可能有本地改动),继续使用现有代码。', '[download] Pull incomplete (possible local changes); using existing code.'), 'stderr')
  } else if (existsSync(target) && readdirSync(target).length > 0) {
    taskLine(label, t('[download] 目标目录非空且非 git 仓库,跳过克隆,仅安装依赖。', '[download] Target dir is non-empty and not a git repo; skipping clone, installing deps only.'), 'stderr')
    taskDone(label, 0)
  } else {
    const clone = await runAsync('git', ['clone', url, target], process.cwd(), label, process.platform === 'win32')
    if (!clone.ok) {
      taskDone(label, clone.code ?? 1)
      return clone
    }
  }

  taskLine(label, t('[download] 安装依赖 (pnpm install)…', '[download] Installing dependencies (pnpm install)…'))
  const install = await pnpmCmd(['install'], target, 'repair')
  if (!install.ok) {
    taskDone(label, install.code ?? 1)
    return install
  }

  // Auto-configure paths so the launcher points at the freshly-downloaded repo.
  const launch = existsSync(join(target, 'apps', 'cli', 'lib', 'bin.js')) ? ['apps/cli/lib/bin.js'] : cfg.launchArgs
  const next = setConfig({
    harnessRepo: target,
    harnessRepoUrl: url,
    dshHome: cfg.dshHome || join(homedir(), '.dsh'),
    profile: cfg.profile || 'web',
    launchArgs: launch,
    nodePath: cfg.nodePath || 'node',
    port: cfg.port || 3080
  })
  taskLine(label, t(`[download] ✔ 完成 — harnessRepo=${next.harnessRepo}`, `[download] ✔ Done — harnessRepo=${next.harnessRepo}`))
  taskLine(label, t(`[download] 启动命令: ${next.nodePath} ${[...next.launchArgs, next.profile].join(' ')}`, `[download] Launch command: ${next.nodePath} ${[...next.launchArgs, next.profile].join(' ')}`))
  taskDone(label, 0)
  return { ok: true, code: 0 }
}

/**
 * Download a plugin from a GitHub repo URL: clone into pluginDir, then install
 * it into the current profile via `dsh plugin add <path>`.
 */
export async function downloadPlugin(url: string): Promise<CmdResult> {
  const cfg = getConfig()
  const gh = parseGitHubUrl(url)
  if (!gh) return { ok: false, code: null, error: t(`无法识别的 GitHub 地址: ${url}`, `Unrecognized GitHub URL: ${url}`) }
  const label = `clone:${gh.repo}`
  const target = join(cfg.pluginDir, gh.repo)

  if (!existsSync(cfg.pluginDir)) mkdirSync(cfg.pluginDir, { recursive: true })

  if (existsSync(join(target, '.git'))) {
    const pull = await runAsync('git', ['-C', target, 'pull', '--ff-only'], process.cwd(), label, process.platform === 'win32')
    if (!pull.ok) taskLine(label, t('[download] 拉取未完成,使用现有代码。', '[download] Pull incomplete; using existing code.'), 'stderr')
  } else {
    const args = ['clone', gh.cloneUrl, target]
    if (gh.ref) args.push('--branch', gh.ref)
    const clone = await runAsync('git', args, process.cwd(), label, process.platform === 'win32')
    if (!clone.ok) {
      taskDone(label, clone.code ?? 1)
      return clone
    }
  }

  taskLine(label, t(`[download] 已就绪: ${target} → 安装到 profile "${cfg.profile}"`, `[download] Ready: ${target} → installing into profile "${cfg.profile}"`))
  taskDone(label, 0)
  return install(cfg.profile, target)
}
