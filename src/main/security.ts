// Security module: reads the dsh-audit probe's audit files (written by the
// dsh-audit plugin inside dsh) and exposes them to the renderer, plus stores
// the probe/security settings. The probe is passive — it only records session
// data-flow events; all reading/monitoring happens here in the launcher.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { getConfig, setConfig } from './config'
import { getInstance, getInstances, instanceDshHome } from './instances'
import * as plugins from './plugins'
import type { CmdResult } from '../shared/types'

/** 探针包名(走 npm 安装,不落本地 DSH-Plugin)。 */
export const PROBE_PACKAGE = '@marcog-h/dsh-audit'
/** 安装 spec:钉死 @latest,避免 pnpm 复用锁文件里的旧坏版(0.1.0 的 cordis.patch 用旧名)。 */
const PROBE_SPEC = '@marcog-h/dsh-audit@latest'

/** One audited session data-flow event, as written by the dsh-audit probe. */
export interface AuditEvent {
  /** event time (ms) */
  t: number
  /** session id */
  sid: string
  /** per-session sequence */
  seq: number
  /** event type: user/message, assistant/message, tool/call, ... */
  type: string
  /** 1 when this is a core data-flow event */
  core: number
  /** sha256 content hash (prefix) */
  h: string
  /** 操作者:发出该事件的插件/角色,如 user、deepseek-v4-flash、某第三方工具/插件名 */
  actor?: string
  /** 原始内容(当 logRawContent 开启时由探针记录) */
  raw?: string
  /** 风险等级:1=低(密钥键名/部分),2=高(完整密钥明文) */
  sev?: number
  /** 脱敏的密钥预览(如 sk-•••ab12),不含完整明文 */
  key?: string
  /** optional flags, e.g. ['credential'] when sensitive-key patterns were detected */
  flags?: string[]
  /** which home's audit file this came from (for display) */
  home?: string
  /** 所属实例 id(由启动器读取时标注) */
  instanceId?: string
  /** 所属实例名(由启动器读取时标注,如 web-2) */
  instanceName?: string
}

/** 每个审计文件及其归属实例(共享 home 的多个实例也按 profile 分开)。 */
interface AuditSource {
  file: string
  instanceId?: string
  instanceName?: string
}

/** 解析所有审计文件来源:每个实例的 audit/<profile>.jsonl + 旧的共享 session.jsonl。 */
function auditSources(): AuditSource[] {
  const out: AuditSource[] = []
  const cfg = getConfig()
  // 旧共享文件(未按 profile 分文件之前写的)。
  if (cfg.dshHome) out.push({ file: join(cfg.dshHome, 'audit', 'session.jsonl') })
  // 每个实例一个审计文件(探针 0.1.5+ 写 audit/<profile>.jsonl)。
  for (const inst of getInstances()) {
    try {
      const home = instanceDshHome(inst)
      if (!home) continue
      out.push({
        file: join(home, 'audit', `${inst.profile ?? 'web'}.jsonl`),
        instanceId: inst.id,
        instanceName: inst.name
      })
    } catch {
      /* 实例数据异常则跳过 */
    }
  }
  return out
}

/** 读取并解析所有审计事件,按时间倒序(新→旧)。文件缺失/损坏静默跳过。 */
export function listAuditEvents(): AuditEvent[] {
  const out: AuditEvent[] = []
  for (const src of auditSources()) {
    let raw: string
    try {
      raw = readFileSync(src.file, 'utf8')
    } catch {
      continue
    }
    const home = dirname(dirname(src.file))
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as AuditEvent
        out.push({ ...ev, home, instanceId: src.instanceId, instanceName: src.instanceName })
      } catch {
        /* 单行损坏跳过 */
      }
    }
  }
  out.sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
  return out
}

/** 真实删除所有审计历史文件(不可恢复),返回删除的文件数。 */
export function clearAudit(): { ok: boolean; removed: number } {
  let removed = 0
  for (const src of auditSources()) {
    try {
      rmSync(src.file, { force: true })
      removed++
    } catch {
      /* 单文件删不掉跳过 */
    }
  }
  return { ok: true, removed }
}

/** 导出结果:CmdResult + 是否取消 + 导出的事件条数。 */
export interface AuditExportResult extends CmdResult {
  canceled?: boolean
  count?: number
}

/** 导出完整审计日志:弹保存框,把聚合后的审计事件写入用户选择的文件(JSONL)。 */
export async function exportAudit(): Promise<AuditExportResult> {
  try {
    const events = listAuditEvents()
    const win = BrowserWindow.getFocusedWindow()
    const { canceled, filePath } = await (win && !win.isDestroyed()
      ? dialog.showSaveDialog(win, {
        title: '导出完整审计日志',
        defaultPath: `dsh-audit-${new Date().toISOString().slice(0, 10)}.jsonl`,
        filters: [{ name: 'JSONL 审计日志', extensions: ['jsonl'] }]
      })
      : dialog.showSaveDialog({
        title: '导出完整审计日志',
        defaultPath: `dsh-audit-${new Date().toISOString().slice(0, 10)}.jsonl`,
        filters: [{ name: 'JSONL 审计日志', extensions: ['jsonl'] }]
      }))
    if (win && !win.isDestroyed()) win.focus()
    if (canceled || !filePath) return { ok: true, code: null, error: undefined, canceled: true }
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')
    writeFileSync(filePath, lines, 'utf8')
    return { ok: true, code: null, error: undefined, count: events.length }
  } catch (e) {
    return { ok: false, code: null, error: String(e) }
  }
}

/** 第三方工具白名单文件路径(userData/dsh-whitelist.txt)。 */
export function whitelistFilePath(): string {
  return join(app.getPath('userData'), 'dsh-whitelist.txt')
}

/** 读取白名单:每行一个第三方工具名,忽略空行与 # / // 注释行。 */
export function getWhitelist(): string[] {
  try {
    const raw = readFileSync(whitelistFilePath(), 'utf8')
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#') && !s.startsWith('//'))
  } catch {
    return []
  }
}

/** 打开白名单文件(不存在则先创建),用系统默认编辑器。 */
export async function openWhitelistFile(): Promise<CmdResult> {
  try {
    const p = whitelistFilePath()
    if (!existsSync(p)) writeFileSync(p, '# 白名单 = 忽略检测的内容。每行一个工具名,名单内的工具即使携带密钥也不告警。\n# 留空 = 检测所有非官方第三方工具。\n# 例:\n# my-http-proxy\n', 'utf8')
    const err = await shell.openPath(p)
    return err ? { ok: false, code: null, error: err } : { ok: true, code: null, error: undefined }
  } catch (e) {
    return { ok: false, code: null, error: String(e) }
  }
}

/** 安全设置。 */
export interface SecurityConfig {
  /** 是否启用探针记录(会话审计)。 */
  probeEnabled: boolean
  /** 是否记录原文(默认只记哈希)。 */
  logRawContent: boolean
  /**
   * 第三方工具/插件白名单:只对名单内的工具事件做风险告警。
   * dsh 官方工具(http-client、bash、read 等)即使携带密钥也不告警。
   */
  thirdPartyTools: string[]
}

export function getSecurityConfig(): SecurityConfig {
  const s = getConfig().security ?? {}
  return {
    probeEnabled: s.probeEnabled !== false,
    logRawContent: s.logRawContent === true,
    thirdPartyTools: Array.isArray(s.thirdPartyTools) ? s.thirdPartyTools : []
  }
}

export function setSecurityConfig(patch: Partial<SecurityConfig>): SecurityConfig {
  const next = { ...getSecurityConfig(), ...patch }
  setConfig({ security: next })
  return next
}

/** 每个实例的探针状态:是否安装了 dsh-audit、是否启用。 */
export interface ProbeStatus {
  instanceId: string
  name: string
  installed: boolean
  enabled: boolean
}

/** 列出所有实例的探针状态。 */
export function listProbeStatus(): ProbeStatus[] {
  return getInstances().map((inst) => {
    try {
      const home = instanceDshHome(inst)
      const { installed } = plugins.listInstalled(home, inst.profile)
      const p = installed.find((x) => x.name === PROBE_PACKAGE)
      return { instanceId: inst.id, name: inst.name, installed: Boolean(p), enabled: Boolean(p?.enabled) }
    } catch {
      return { instanceId: inst.id, name: inst.name, installed: false, enabled: false }
    }
  })
}

/**
 * 清理探针「旧名残留」:改名前的包名是 `dsh-audit`(0.1.0),升级到
 * `@marcog-h/dsh-audit` 时旧依赖/旧 node_modules 目录可能残留,让加载器
 * 按旧名 import 而崩溃。安装/重装前清一次,幂等、静默。
 */
function cleanLegacyProbe(home: string, profile: string): void {
  try {
    const pkgPath = join(home, 'profiles', profile, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const deps = pkg.dependencies ?? {}
    if ('dsh-audit' in deps) {
      delete deps['dsh-audit']
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
    }
  } catch {
    /* 忽略 */
  }
  try {
    rmSync(join(home, 'profiles', profile, 'node_modules', 'dsh-audit'), { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

// 探针安装额外 flag:绕过 pnpm 的 minimumReleaseAge(默认约 2 天)。新发布的探针
// 版本会被等待期拦下,@latest 静默落到最老可用版(不报错,导致"重装不升级")。
const PROBE_INSTALL_FLAGS = ['--config.minimumReleaseAge=0']

/** 给指定实例安装探针(走 npm,强制最新版,先清旧名残留)。 */
export async function installProbe(instanceId: string): Promise<CmdResult> {
  const inst = getInstance(instanceId)
  if (!inst) return { ok: false, code: null, error: 'Instance not found' }
  const home = instanceDshHome(inst)
  cleanLegacyProbe(home, inst.profile)
  return plugins.install(home, inst.profile, PROBE_SPEC, PROBE_PACKAGE, PROBE_INSTALL_FLAGS)
}

/** 卸载指定实例的探针。 */
export async function removeProbe(instanceId: string): Promise<CmdResult> {
  const inst = getInstance(instanceId)
  if (!inst) return { ok: false, code: null, error: 'Instance not found' }
  const home = instanceDshHome(inst)
  cleanLegacyProbe(home, inst.profile)
  return plugins.remove(home, inst.profile, PROBE_PACKAGE)
}

/** 重装指定实例的探针(先卸后装,拉最新版)。 */
export async function reinstallProbe(instanceId: string): Promise<CmdResult> {
  const inst = getInstance(instanceId)
  if (!inst) return { ok: false, code: null, error: 'Instance not found' }
  const home = instanceDshHome(inst)
  cleanLegacyProbe(home, inst.profile)
  await plugins.remove(home, inst.profile, PROBE_PACKAGE)
  return plugins.install(home, inst.profile, PROBE_SPEC, PROBE_PACKAGE, PROBE_INSTALL_FLAGS)
}
