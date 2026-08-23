// 浏览器守卫:--no-open 参数对部分 dsh 版本/场景会失效(浏览器已运行时复用标签,
// 命令行不带 URL),这里做一层兜底——实例就绪后的一小段时间内**高频**检查浏览器
// 进程,若它打开了该实例的本地地址则关闭。窗口结束即停止,不做常驻轮询。
//
// 「用户手动打开」= 在控制台点「打开 Web UI」按钮(harness:openUi),会调用
// markUserOpened 记录该端口,守卫跳过它——用户主动打开的浏览器理应保留。

import { spawn } from 'node:child_process'

/** 用户手动打开的端口(守卫不关闭)。 */
const userOpenedPorts = new Set<number>()

/** 记录一个「用户手动打开」的端口,守卫将跳过它。 */
export function markUserOpened(port: number): void {
  if (port > 0) userOpenedPorts.add(port)
}

/** 关闭打开了指定本地端口的浏览器进程(用户手动打开的除外)。 */
function sweepPort(port: number): void {
  if (process.platform !== 'win32') return
  if (userOpenedPorts.has(port)) return
  const ps = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "msedge|chrome|firefox|brave|vivaldi|opera" } | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  let out = ''
  ps.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
  ps.on('error', () => { /* 枚举失败无碍,下一轮再试 */ })
  ps.on('close', () => {
    const re = new RegExp(`(?:127\\.0\\.0\\.1|localhost):${port}\\b`, 'i')
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\d+)\t/.exec(line)
      if (!m || !re.test(line)) continue
      // 结束该浏览器进程(带进程树)。
      spawn('taskkill', ['/F', '/T', '/PID', m[1]], { windowsHide: true, stdio: 'ignore' }).unref()
    }
  })
}

/** 正在守卫的端口 → 其定时器(防止同端口重复开窗/重复实例)。 */
const watchers = new Map<number, NodeJS.Timeout>()

/**
 * 实例就绪后,对该端口开启一段「短时高频」守卫窗口:浏览器若在启动时被 dsh 自动
 * 弹出,会在这一小段时间内被高频检测到并关闭;窗口结束后不再检测,避免常驻开销。
 */
export function watchPort(port: number, durationMs = 30_000, intervalMs = 1_000): void {
  if (port <= 0 || watchers.has(port)) return
  const timer = setInterval(() => sweepPort(port), intervalMs)
  watchers.set(port, timer)
  setTimeout(() => {
    clearInterval(timer)
    watchers.delete(port)
  }, durationMs)
}
