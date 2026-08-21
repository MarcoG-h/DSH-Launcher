// Portable "bundled" runtime: a self-contained Node + npm + @deepseek-ai/dsh
// install under runtimeRoot (~/.dsh-runtime). Target machines need no Node.js,
// no pnpm, and no harness source checkout.

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { getConfig, setConfig } from './config'
import { t } from './i18n'
import { runAsync, taskDone, taskLine, taskProgress } from './task'
import type { CmdResult } from '../shared/types'

// Timeouts for the portable-install steps so a slow or hung child (tar / npm on
// a slow disk, or a non-C: drive) can never leave the deploy spinner stuck
// forever — the watchdog only prints "still running", it doesn't abort.
const EXTRACT_TIMEOUT_MS = 5 * 60_000
const NPM_TIMEOUT_MS = 20 * 60_000

// npm/pnpm installs inside the deploy must use the same mirror — otherwise a
// China-based machine crawls on the default registry and the deploy looks hung.
const REGISTRY = 'https://registry.npmmirror.com'

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

/** 当前内置 @deepseek-ai/dsh 的版本;未安装内置运行环境时返回 null。 */
export function currentDshVersion(): string | null {
  try {
    const p = join(dshInstallDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (!existsSync(p)) return null
    return String((JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }).version ?? '')
  } catch {
    return null
  }
}

/** 查询 registry 上 @deepseek-ai/dsh 的最新稳定版本;网络失败返回 null(不抛错)。 */
export function latestDshVersion(timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpsGet(`${REGISTRY}/@deepseek-ai/dsh/latest`, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          const data = JSON.parse(body) as { version?: unknown }
          resolve(typeof data.version === 'string' && data.version ? data.version : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

/** 当前内置 dsh 版本 vs 官方最新版。 */
export interface DshUpdateCheck {
  latest: string | null
  current: string | null
  update: boolean
}

/** 对比当前内置 dsh 与官方最新稳定版;仅当两者都存在且不同时视为有更新。 */
export async function checkDshUpdate(): Promise<DshUpdateCheck> {
  const latest = await latestDshVersion()
  const current = currentDshVersion()
  return { latest, current, update: latest !== null && current !== null && latest !== current }
}

/** 比较语义化版本 a 与 b:返回正数(a>b) / 0 / 负数(a<b)。 */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((x) => Number(x) || 0)
  const pb = b.replace(/^v/, '').split('.').map((x) => Number(x) || 0)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/** 启动器(DSH-Launcher)自身最新版 vs 当前版本。 */
export interface LauncherUpdateCheck {
  latest: string | null
  current: string
  url: string | null
  update: boolean
}

/**
 * 查询 GitHub 上 DSH-Launcher 的最新 Release,与当前运行版本对比。提示式更新:
 * 网络失败/查不到时静默返回(update=false),不影响使用;UI 只在有新版本时提示
 * 用户点击下载,不自动安装(免签名、免下载通道问题)。
 */
export async function checkLauncherUpdate(timeoutMs = 8000): Promise<LauncherUpdateCheck> {
  const current = app.getVersion()
  const remote = await new Promise<{ tag: string | null; url: string | null }>((resolve) => {
    const req = httpsGet(
      'https://api.github.com/repos/MarcoG-h/DSH-Launcher/releases/latest',
      { timeout: timeoutMs, headers: { 'User-Agent': 'DSH-Launcher' } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          try {
            const data = JSON.parse(body) as { tag_name?: unknown; html_url?: unknown }
            resolve({
              tag: typeof data.tag_name === 'string' ? data.tag_name : null,
              url: typeof data.html_url === 'string' ? data.html_url : null
            })
          } catch {
            resolve({ tag: null, url: null })
          }
        })
      },
    )
    req.on('timeout', () => { req.destroy(); resolve({ tag: null, url: null }) })
    req.on('error', () => resolve({ tag: null, url: null }))
  })
  const latest = remote.tag ? remote.tag.replace(/^v/, '') : null
  return {
    latest,
    current,
    url: remote.url,
    update: latest !== null && compareSemver(latest, current) > 0
  }
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

export function downloadFile(url: string, dest: string, onProgress: (received: number, total: number | null) => void): Promise<void> {
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
export function progressLine(label: string): (received: number, total: number | null) => void {
  let last = 0
  return (received, total) => {
    if (received - last < 2 * 1024 * 1024) return
    last = received
    const mb = (received / 1024 / 1024).toFixed(1)
    const tot = total ? ` / ${(total / 1024 / 1024).toFixed(1)}MB` : ''
    taskLine(label, t(`[runtime] 下载中 ${mb}MB${tot}…`, `[runtime] Downloading ${mb}MB${tot}…`))
  }
}

/**
 * Extract a zip archive into `destDir`. Windows ships bsdtar (`tar -xf`
 * handles zip); fall back to PowerShell Expand-Archive. Returns false on
 * failure — the caller decides whether the expected output is present.
 */
export async function extractZip(zipPath: string, destDir: string, label: string): Promise<boolean> {
  const x = await runAsync('tar', ['-xf', zipPath, '-C', destDir], destDir, label, process.platform === 'win32', undefined, EXTRACT_TIMEOUT_MS)
  if (x.ok) return true
  taskLine(label, t('[runtime] tar 解压失败,改用 PowerShell Expand-Archive…', '[runtime] tar extraction failed, falling back to PowerShell Expand-Archive…'), 'stderr')
  const ps = await runAsync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'`],
    destDir,
    label,
    true,
    undefined,
    EXTRACT_TIMEOUT_MS
  )
  return ps.ok
}

// --- install / update ---

/**
 * One-click portable environment install:
 *  1. download + unpack portable Node (npmmirror) into runtimeRoot/node
 *  2. npm install -g pnpm (needed for `dsh plugin` and for step 3)
 *  3. pnpm add @deepseek-ai/dsh@<dshVersion> into runtimeRoot/dsh (full built-in bundle closure).
 *     pnpm is used instead of a bare npm install because npm without a lockfile drifts on
 *     the pi-ai/typebox transitive pins (the user-visible `Cannot find module typebox` boot
 *     failure) and tries to compile koffi from source (needs cmake / VS build tools), while
 *     pnpm resolves the same versions the official repo lockfile pins and pulls the
 *     @koromix/koffi platform + node-pty prebuilt packages — no compiler needed.
 *     (--config.strictDepBuilds=false makes pnpm treat un-approved install scripts as a
 *     warning instead of failing the whole install; those scripts are no-ops here because
 *     the native deps arrive as prebuilt platform packages.)
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
  // dsh 不在安装包里自带,部署时从 registry 拉取。始终实时抓取 npm 最新稳定版:
  // latest 标签每次由 pnpm 现场解析,不依赖任何固定版本号——固定版本会错过新版。
  const dshVer = 'latest'
  const dir = nodeDir()
  const stage = join(root, '.node-stage')
  const zip = join(root, `node-v${ver}-win-x64.zip`)
  const inner = join(stage, `node-v${ver}-win-x64`)
  const url = `https://registry.npmmirror.com/-/binary/node/v${ver}/node-v${ver}-win-x64.zip`
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
    const okExtract = await extractZip(zip, stage, label)
    if (!okExtract || !existsSync(inner)) {
      taskDone(label, 1)
      return { ok: false, code: 1, error: t('Node 解压失败(请检查磁盘空间 / 网络)', 'Failed to extract Node (check disk space / network)') }
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    renameSync(inner, dir)
    rmSync(stage, { recursive: true, force: true })
    rmSync(zip, { force: true })
    taskLine(label, t(`[runtime] ✔ Node 就绪: ${nodeExe()}`, `[runtime] ✔ Node ready: ${nodeExe()}`))
  }

  // 2. pnpm for `dsh plugin` and for the dsh install in step 3.
  const npm = join(dir, 'npm.cmd')
  const pnpm = join(dir, 'pnpm.cmd')
  taskProgress(label, 0.45, t('安装 pnpm', 'Installing pnpm'))
  if (!existsSync(pnpm)) {
    taskLine(label, t('[runtime] 安装 pnpm(供 dsh 安装与 plugin 使用)…', '[runtime] Installing pnpm (for dsh install & plugin)…'))
    const p = await runAsync(npm, ['install', '-g', 'pnpm', ...npmOpts], dir, label, process.platform === 'win32', undefined, NPM_TIMEOUT_MS)
    if (!p.ok) {
      taskDone(label, p.code ?? 1)
      return p
    }
  }

  // 3. bundled dsh (full built-in plugin closure lives in its node_modules).
  //    Installed with pnpm so transitive pins (pi-ai/typebox) match the official
  //    lockfile and native deps (koffi, node-pty) come as prebuilt platform
  //    packages — a bare npm install drifts here and needs a compiler for koffi.
  const dshDir = dshInstallDir()
  mkdirSync(dshDir, { recursive: true })
  const pkg = join(dshDir, 'package.json')
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({ name: 'dsh-runtime', private: true, version: '0.0.0' }, null, 2) + '\n', 'utf8')
  }
  taskLine(label, t(`[runtime] 安装 @deepseek-ai/dsh@${dshVer}(含全部内置插件)…`, `[runtime] Installing @deepseek-ai/dsh@${dshVer} (with all built-in plugins)…`))
  taskProgress(label, 0.5, t(`安装 @deepseek-ai/dsh@${dshVer}(体积较大,请稍候)`, `Installing @deepseek-ai/dsh@${dshVer} (large download, please wait)`))
  const ins = await runAsync(pnpm, ['add', `@deepseek-ai/dsh@${dshVer}`, `--registry=${REGISTRY}`, '--config.strictDepBuilds=false'], dshDir, label, process.platform === 'win32', undefined, NPM_TIMEOUT_MS)
  if (!ins.ok) {
    taskDone(label, ins.code ?? 1)
    return ins
  }
  if (!existsSync(dshBin())) {
    taskDone(label, 1)
    return { ok: false, code: 1, error: t('安装后未找到 dsh 入口(lib/bin.js)', 'dsh entry not found after install (lib/bin.js)') }
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
  // 实时抓取 npm 最新稳定版(latest 由 pnpm 每次现场解析),不按固定版本号判断。
  const dshVer = 'latest'
  const pnpm = join(nodeDir(), 'pnpm.cmd')
  if (!existsSync(pnpm)) {
    taskLine(label, t('[runtime] 未找到 pnpm,请先重新「一键安装运行环境」。', '[runtime] pnpm not found — please re-run "Install runtime" first.'), 'stderr')
    taskDone(label, 1)
    return { ok: false, code: 1, error: t('运行环境缺少 pnpm,请重新一键安装', 'Runtime is missing pnpm — re-run one-click install') }
  }
  taskLine(label, t(`[runtime] 升级 @deepseek-ai/dsh@${dshVer}(不触碰 ~/.dsh 的第三方插件)…`, `[runtime] Upgrading @deepseek-ai/dsh@${dshVer} (third-party plugins in ~/.dsh are untouched)…`))
  // 带百分比的进度条:pnpm 下载/安装期间定时递增(0.1→0.9),让进度条持续走动;
  // 完成后 taskDone(0) 会把进度收束到 100%。
  taskProgress(label, 0.1, t('开始升级…', 'Starting upgrade…'))
  let progress = 0.1
  const tick = setInterval(() => {
    progress = Math.min(0.9, progress + 0.05)
    taskProgress(label, progress, t(`安装中…(${Math.round(progress * 100)}%)`, `Installing… (${Math.round(progress * 100)}%)`))
  }, 2500)
  try {
    const r = await runAsync(pnpm, ['add', `@deepseek-ai/dsh@${dshVer}`, `--registry=${REGISTRY}`, '--config.strictDepBuilds=false'], dshInstallDir(), label, process.platform === 'win32')
    if (!r.ok) {
      taskDone(label, r.code ?? 1)
      return r
    }
    taskLine(label, t('[runtime] ✔ 内置 dsh 已升级', '[runtime] ✔ Built-in dsh upgraded'))
    taskDone(label, 0)
    return { ok: true, code: 0 }
  } finally {
    clearInterval(tick)
  }
}
