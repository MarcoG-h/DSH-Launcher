// Portable "bundled" runtime: a self-contained Node + npm + @deepseek-ai/dsh
// install under runtimeRoot (~/.dsh-runtime). Target machines need no Node.js,
// no pnpm, and no harness source checkout.

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { getConfig, setConfig } from './config'
import { runAsync, taskDone, taskLine } from './task'
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
    const req = httpsGet(url, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        file.destroy()
        res.resume()
        req.destroy()
        const next = new URL(res.headers.location, url).toString()
        downloadFile(next, dest, onProgress).then(resolve, reject)
        return
      }
      if (status !== 200) {
        file.destroy()
        res.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }
      const total = Number(res.headers['content-length'] ?? 0) || null
      let received = 0
      res.on('data', (c: Buffer) => {
        received += c.length
        onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
    })
    req.on('error', reject)
    file.on('error', reject)
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
    taskLine(label, `[runtime] 下载中 ${mb}MB${tot}…`)
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
  const ver = cfg.nodeVersion || '22.14.0'
  const dshVer = cfg.dshVersion || '0.1.0-rc.6'
  const dir = nodeDir()
  const stage = join(root, '.node-stage')
  const zip = join(root, `node-v${ver}-win-x64.zip`)
  const inner = join(stage, `node-v${ver}-win-x64`)
  const url = `https://registry.npmmirror.com/-/binary/node/v${ver}/node-v${ver}-win-x64.zip`

  mkdirSync(root, { recursive: true })
  taskLine(label, `[runtime] 目标目录: ${root}`)

  // 1. portable Node
  if (existsSync(nodeExe())) {
    taskLine(label, `[runtime] Node v${ver} 已存在,跳过下载`)
  } else {
    taskLine(label, `[runtime] 下载 Node v${ver} …`)
    try {
      await downloadFile(url, zip, progressLine(label))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      taskLine(label, `[runtime] 下载失败: ${message}`, 'stderr')
      taskDone(label, 1)
      return { ok: false, code: 1, error: `下载 Node 失败: ${message}` }
    }

    taskLine(label, `[runtime] 解压到 ${dir} …`)
    mkdirSync(stage, { recursive: true })
    // Windows ships bsdtar, which extracts zip archives.
    const x = await runAsync('tar', ['-xf', zip, '-C', stage], root, label, process.platform === 'win32')
    if (!x.ok || !existsSync(inner)) {
      taskLine(label, 'tar 解压失败,改用 PowerShell Expand-Archive…', 'stderr')
      const ps = await runAsync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${stage}'`],
        root,
        label,
        true
      )
      if (!ps.ok || !existsSync(inner)) {
        taskDone(label, 1)
        return { ok: false, code: 1, error: 'Node 解压失败(请检查磁盘空间 / 网络)' }
      }
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    renameSync(inner, dir)
    rmSync(stage, { recursive: true, force: true })
    rmSync(zip, { force: true })
    taskLine(label, `[runtime] ✔ Node 就绪: ${nodeExe()}`)
  }

  // 2. bundled dsh (full built-in plugin closure lives in its node_modules)
  const dshDir = dshInstallDir()
  mkdirSync(dshDir, { recursive: true })
  const pkg = join(dshDir, 'package.json')
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({ name: 'dsh-runtime', private: true, version: '0.0.0' }, null, 2) + '\n', 'utf8')
  }
  taskLine(label, `[runtime] 安装 @deepseek-ai/dsh@${dshVer}(含全部内置插件)…`)
  const npm = join(dir, 'npm.cmd')
  const ins = await runAsync(npm, ['install', `@deepseek-ai/dsh@${dshVer}`, '--no-fund', '--no-audit'], dshDir, label, process.platform === 'win32')
  if (!ins.ok) {
    taskDone(label, ins.code ?? 1)
    return ins
  }
  if (!existsSync(dshBin())) {
    taskDone(label, 1)
    return { ok: false, code: 1, error: '安装后未找到 dsh 入口(lib/bin.js)' }
  }

  // 3. pnpm for `dsh plugin`
  if (!existsSync(join(dir, 'pnpm.cmd'))) {
    taskLine(label, '[runtime] 安装 pnpm(供 dsh plugin 使用)…')
    const pnpm = await runAsync(npm, ['install', '-g', 'pnpm', '--no-fund', '--no-audit'], dir, label, process.platform === 'win32')
    if (!pnpm.ok) {
      taskDone(label, pnpm.code ?? 1)
      return pnpm
    }
  }

  // 4. auto-configure paths so the launcher switches to bundled mode.
  const next = setConfig({
    installMode: 'bundled',
    runtimeRoot: root,
    nodePath: nodeExe(),
    launchArgs: [dshBin()],
    dshHome: cfg.dshHome || join(homedir(), '.dsh'),
    profile: cfg.profile || 'web',
    pnpm: join(dir, 'pnpm.cmd')
  })
  taskLine(label, '[runtime] ✔ 完成 — 已切换为 bundled 模式')
  taskLine(label, `[runtime] 启动命令: ${next.nodePath} ${[...next.launchArgs, next.profile].join(' ')}`)
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
    taskLine(label, '[runtime] 尚未安装运行环境,请先「一键安装运行环境」。', 'stderr')
    taskDone(label, 1)
    return { ok: false, code: 1, error: '运行环境未安装' }
  }
  const dshVer = cfg.dshVersion || '0.1.0-rc.6'
  const npm = join(nodeDir(), 'npm.cmd')
  taskLine(label, `[runtime] 升级 @deepseek-ai/dsh@${dshVer}(不触碰 ~/.dsh 的第三方插件)…`)
  const r = await runAsync(npm, ['install', `@deepseek-ai/dsh@${dshVer}`, '--no-fund', '--no-audit'], dshInstallDir(), label, process.platform === 'win32')
  if (!r.ok) return r
  taskLine(label, '[runtime] ✔ 内置 dsh 已升级')
  taskDone(label, 0)
  return { ok: true, code: 0 }
}
