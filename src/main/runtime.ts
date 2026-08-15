// Portable "bundled" runtime: a self-contained Node + npm + @deepseek-ai/dsh
// install under runtimeRoot (~/.dsh-runtime). Target machines need no Node.js,
// no pnpm, and no harness source checkout.

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { getConfig, setConfig } from './config'
import { t } from './i18n'
import { runAsync, taskDone, taskLine, taskProgress } from './task'
import type { CmdResult } from '../shared/types'

// --- layout helpers (always resolve from the live config) ---

export function nodeDir(): string {
  return join(getConfig().runtimeRoot, 'node')
}

export function nodeExe(): string {
  return join(nodeDir(), 'node.exe')
}

export function dshInstallDir(): string {
  return join(getConfig().runtimeRoot, 'dsh')
}

export function dshBin(): string {
  return join(dshInstallDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

export function resolveBundledNode(): string | null {
  return existsSync(nodeExe()) ? nodeExe() : null
}

export function resolveBundledDshBin(): string | null {
  return existsSync(dshBin()) ? dshBin() : null
}

export function runtimeInstalled(): boolean {
  return resolveBundledNode() !== null && resolveBundledDshBin() !== null
}

/** Compare dotted version strings: returns true when a >= b (missing parts = 0). */
function nodeVersionAtLeast(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** Version of the installed portable Node, or null if absent/unreadable. */
function installedNodeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!existsSync(nodeExe())) {
      resolve(null)
      return
    }
    const p = spawn(nodeExe(), ['-v'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    p.on('error', () => resolve(null))
    p.on('close', () => resolve(out.trim().replace(/^v/, '') || null))
  })
}

/**
 * Environment patch for bundled-mode children: force DSH_HOME to the configured
 * dshHome and prepend the portable node dir to PATH so npm/pnpm (spawned by the
 * bundled dsh for `dsh plugin`) resolve to the bundled copies.
 */
export function bundledEnv(): NodeJS.ProcessEnv {
  const cfg = getConfig()
  const dir = nodeDir()
  const oldPath = process.env.PATH ?? ''
  return {
    DSH_HOME: cfg.dshHome,
    PATH: `${dir}${delimiter}${oldPath}`
  }
}

// --- download helper (node https, follows redirects, reports progress) ---

function downloadFile(url: string, dest: string, onProgress: (received: number, total: number | null) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    let req: ReturnType<typeof httpsGet>
    // Abort if no bytes arrive for a while — a stalled connection should surface
    // as a clear error instead of hanging the deploy forever.
    let stalled: ReturnType<typeof setTimeout> | null = null
    const armStall = (): void => {
      if (stalled) clearTimeout(stalled)
      stalled = setTimeout(() => {
        req.destroy(new Error(t('下载超时(60 秒无数据)— 请检查网络后重试', 'Download timed out (60s with no data) — check your network and retry')))
      }, 60_000)
    }
    const disarmStall = (): void => {
      if (stalled) clearTimeout(stalled)
      stalled = null
    }
    req = httpsGet(url, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        disarmStall()
        file.destroy()
        res.resume()
        req.destroy()
        const next = new URL(res.headers.location, url).toString()
        downloadFile(next, dest, onProgress).then(resolve, reject)
        return
      }
      if (status !== 200) {
        disarmStall()
        file.destroy()
        res.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }
      const total = Number(res.headers['content-length'] ?? 0) || null
      let received = 0
      res.on('data', (c: Buffer) => {
        received += c.length
        armStall()
        onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => {
        disarmStall()
        file.close(() => resolve())
      })
    })
    armStall()
    req.on('error', (err) => {
      disarmStall()
      reject(err)
    })
    file.on('error', (err) => {
      disarmStall()
      reject(err)
    })
  })
}

/** Progress reporter that emits a task line roughly every 2 MB. */
function progressLine(label: string): (received: number, total: number | null) => void {
  let last = 0
  return (received, total) => {
    if (received - last < 2 * 1024 * 1024) return
    last = received
    const mb = (received / 1024 / 1024).toFixed(1)
    const tot = total ? ` / ${(total / 1024 / 1024).toFixed(1)}MB` : ''
    taskLine(label, t(`[runtime] 下载中 ${mb}MB${tot}…`, `[runtime] Downloading ${mb}MB${tot}…`))
  }
}

// --- install / update ---

/**
 * One-click portable environment install:
 *  1. download + unpack portable Node (npmmirror) into runtimeRoot/node
 *  2. npm install @deepseek-ai/dsh@<dshVersion> into runtimeRoot/dsh (full built-in bundle closure)
 *  3. npm install -g pnpm (for `dsh plugin` inside the bundled CLI)
 *  4. auto-configure the launcher to bundled mode
 */
export async function installRuntime(): Promise<CmdResult> {
  const cfg = getConfig()
  const label = 'runtime:install'
  const root = cfg.runtimeRoot
  // The DSH team's community red line is Node ≥22.19 (below it, node:zlib lacks
  // zstd and AbortSignal.timeout) — bump old persisted versions up to the minimum
  // so the bundled dsh can boot (e.g. existing 22.14 installs self-heal on re-deploy).
  const MIN_NODE = '22.19.0'
  const ver = nodeVersionAtLeast(cfg.nodeVersion || '', MIN_NODE) ? cfg.nodeVersion : MIN_NODE
  const dshVer = cfg.dshVersion || '0.1.0-rc.6'
  const dir = nodeDir()
  const stage = join(root, '.node-stage')
  const zip = join(root, `node-v${ver}-win-x64.zip`)
  const inner = join(stage, `node-v${ver}-win-x64`)
  const url = `https://registry.npmmirror.com/-/binary/node/v${ver}/node-v${ver}-win-x64.zip`
  // npm installs inside the deploy must use the same mirror — otherwise a
  // China-based machine crawls on the default registry and the deploy looks hung.
  const REGISTRY = 'https://registry.npmmirror.com'
  const npmOpts = ['--no-fund', '--no-audit', '--engine-strict=false', `--registry=${REGISTRY}`]

  mkdirSync(root, { recursive: true })
  taskLine(label, t(`[runtime] 目标目录: ${root}`, `[runtime] Target directory: ${root}`))

  // Ensure the plugin directory exists too, so a fresh install isn't left with
  // a dangling Settings path (plugins.ts only creates it on first GitHub install).
  const pluginDir = cfg.pluginDir || join(homedir(), 'DSH-Plugin')
  mkdirSync(pluginDir, { recursive: true })

  // 1. portable Node — skip only when the installed version already satisfies
  //    the target (dsh needs ≥22.17 for node:zlib zstd); otherwise re-download.
  const installedNode = await installedNodeVersion()
  if (installedNode && nodeVersionAtLeast(installedNode, ver)) {
    taskLine(label, t(`[runtime] Node v${installedNode} 已存在,跳过下载`, `[runtime] Node v${installedNode} already present, skipping download`))
  } else {
    if (installedNode) {
      taskLine(label, t(`[runtime] Node v${installedNode} 过旧(dsh 需要 ≥${ver}),重新下载…`, `[runtime] Node v${installedNode} is too old (dsh needs ≥${ver}), re-downloading…`), 'stderr')
    }
    taskLine(label, t(`[runtime] 下载 Node v${ver} …`, `[runtime] Downloading Node v${ver} …`))
    taskProgress(label, 0.02, t('下载 Node(约 30MB)', 'Downloading Node (~30MB)'))
    const logDownload = progressLine(label)
    // Throttle the bar to ~1% buckets so per-chunk progress doesn't flood IPC.
    let lastBucket = -1
    try {
      await downloadFile(url, zip, (received, total) => {
        logDownload(received, total)
        // Bytes-driven progress for the bar; guess size when no Content-Length.
        const pct = total ? received / total : Math.min(1, received / (30 * 1024 * 1024))
        const bucket = Math.floor(pct * 100)
        if (bucket !== lastBucket) {
          lastBucket = bucket
          taskProgress(label, 0.02 + 0.38 * pct, t('下载 Node', 'Downloading Node'))
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskLine(label, t(`[runtime] 下载失败: ${message}`, `[runtime] Download failed: ${message}`), 'stderr')
      taskDone(label, 1)
      return { ok: false, code: 1, error: t(`下载 Node 失败: ${message}`, `Failed to download Node: ${message}`) }
    }

    taskLine(label, t(`[runtime] 解压到 ${dir} …`, `[runtime] Extracting to ${dir} …`))
    taskProgress(label, 0.42, t('解压 Node', 'Extracting Node'))
    mkdirSync(stage, { recursive: true })
    // Windows ships bsdtar, which extracts zip archives.
    const x = await runAsync('tar', ['-xf', zip, '-C', stage], root, label, process.platform === 'win32')
    if (!x.ok || !existsSync(inner)) {
      taskLine(label, t('tar 解压失败,改用 PowerShell Expand-Archive…', 'tar extraction failed, falling back to PowerShell Expand-Archive…'), 'stderr')
      const ps = await runAsync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${stage}'`],
        root,
        label,
        true
      )
      if (!ps.ok || !existsSync(inner)) {
        taskDone(label, 1)
        return { ok: false, code: 1, error: t('Node 解压失败(请检查磁盘空间 / 网络)', 'Failed to extract Node (check disk space / network)') }
      }
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    renameSync(inner, dir)
    rmSync(stage, { recursive: true, force: true })
    rmSync(zip, { force: true })
    taskLine(label, t(`[runtime] ✔ Node 就绪: ${nodeExe()}`, `[runtime] ✔ Node ready: ${nodeExe()}`))
  }

  // 2. bundled dsh (full built-in plugin closure lives in its node_modules)
  const dshDir = dshInstallDir()
  mkdirSync(dshDir, { recursive: true })
  const pkg = join(dshDir, 'package.json')
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({ name: 'dsh-runtime', private: true, version: '0.0.0' }, null, 2) + '\n', 'utf8')
  }
  taskLine(label, t(`[runtime] 安装 @deepseek-ai/dsh@${dshVer}(含全部内置插件)…`, `[runtime] Installing @deepseek-ai/dsh@${dshVer} (with all built-in plugins)…`))
  taskProgress(label, 0.45, t(`安装 @deepseek-ai/dsh@${dshVer}(体积较大,请稍候)`, `Installing @deepseek-ai/dsh@${dshVer} (large download, please wait)`))
  const npm = join(dir, 'npm.cmd')
  const ins = await runAsync(npm, ['install', `@deepseek-ai/dsh@${dshVer}`, ...npmOpts], dshDir, label, process.platform === 'win32')
  if (!ins.ok) {
    taskDone(label, ins.code ?? 1)
    return ins
  }
  if (!existsSync(dshBin())) {
    taskDone(label, 1)
    return { ok: false, code: 1, error: t('安装后未找到 dsh 入口(lib/bin.js)', 'dsh entry not found after install (lib/bin.js)') }
  }

  // 3. pnpm for `dsh plugin`
  taskProgress(label, 0.86, t('安装 pnpm', 'Installing pnpm'))
  if (!existsSync(join(dir, 'pnpm.cmd'))) {
    taskLine(label, t('[runtime] 安装 pnpm(供 dsh plugin 使用)…', '[runtime] Installing pnpm (for dsh plugin)…'))
    const pnpm = await runAsync(npm, ['install', '-g', 'pnpm', ...npmOpts], dir, label, process.platform === 'win32')
    if (!pnpm.ok) {
      taskDone(label, pnpm.code ?? 1)
      return pnpm
    }
  }

  // 4. auto-configure paths so the launcher switches to bundled mode.
  taskProgress(label, 0.96, t('写入配置', 'Writing config'))
  const next = setConfig({
    installMode: 'bundled',
    runtimeRoot: root,
    nodeVersion: ver,
    nodePath: nodeExe(),
    launchArgs: [dshBin()],
    dshHome: cfg.dshHome || join(homedir(), '.dsh'),
    profile: cfg.profile || 'web',
    pnpm: join(dir, 'pnpm.cmd')
  })
  taskProgress(label, 1, t('部署完成', 'Deployment complete'))
  taskLine(label, t('[runtime] ✔ 完成 — 已切换为 bundled 模式', '[runtime] ✔ Done — switched to bundled mode'))
  taskLine(label, t(`[runtime] 启动命令: ${next.nodePath} ${[...next.launchArgs, next.profile].join(' ')}`, `[runtime] Launch command: ${next.nodePath} ${[...next.launchArgs, next.profile].join(' ')}`))
  taskDone(label, 0)
  return { ok: true, code: 0 }
}

/**
 * Upgrade only the bundled @deepseek-ai/dsh package inside runtimeRoot.
 * The install directory is physically separate from ~/.dsh, so third-party
 * plugins and cordis.patch.yml user entries are untouched.
 */
export async function updateRuntime(): Promise<CmdResult> {
  const cfg = getConfig()
  const label = 'runtime:update'
  if (!existsSync(nodeExe())) {
    taskLine(label, t('[runtime] 尚未安装运行环境,请先「一键安装运行环境」。', '[runtime] Runtime not installed yet — click "Install runtime" first.'), 'stderr')
    taskDone(label, 1)
    return { ok: false, code: 1, error: t('运行环境未安装', 'Runtime not installed') }
  }
  const dshVer = cfg.dshVersion || '0.1.0-rc.6'
  const npm = join(nodeDir(), 'npm.cmd')
  taskLine(label, t(`[runtime] 升级 @deepseek-ai/dsh@${dshVer}(不触碰 ~/.dsh 的第三方插件)…`, `[runtime] Upgrading @deepseek-ai/dsh@${dshVer} (third-party plugins in ~/.dsh are untouched)…`))
  const r = await runAsync(npm, ['install', `@deepseek-ai/dsh@${dshVer}`, '--no-fund', '--no-audit'], dshInstallDir(), label, process.platform === 'win32')
  if (!r.ok) return r
  taskLine(label, t('[runtime] ✔ 内置 dsh 已升级', '[runtime] ✔ Built-in dsh upgraded'))
  taskDone(label, 0)
  return { ok: true, code: 0 }
}
