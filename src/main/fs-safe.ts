// 安全目录删除 —— 绕开 Electron 主进程删目录的两个坑(2026-09-18 实测复核)。
//
// 坑 1(数据安全,必须防):Electron 43.4.0 主进程里 `fs.rmSync(dir,{recursive:true,force:true})`
//   遇到目录树里的 junction / 符号链接会**穿透链接、删掉目标目录里的内容**。
//   实测(mklink /J 建链接):裸 rmSync 整棵树后,链接指向的 target 里文件全被清空,
//   只有 target 目录本身还在;而「先 unlink 链接、再 rmSync」则目标完完整整。
//   现实危险点:pluginDir 根级 `node_modules` 是指向 `~/.dsh/profiles/node_modules` 的
//   junction —— 任何一次「删掉含该链接的目录」都会把全部实例共用的 node_modules 清空。
//   对策:删除前递归 unlink 目录内的链接(只摘链接,绝不进入目标)。
//
// 坑 2(误报「被占用」,即本次用户反馈):同步 rmSync 在 Windows 上**不做重试**
//   —— maxRetries / retryDelay 只有异步 `fs.rm` 才实现。于是树里任何一个文件此刻
//   被别人打开(编辑器/杀软/索引/资源管理器预览),或刚被删除、还处于 delete-pending,
//   就会立刻抛 EPERM/EBUSY(实测 3ms 就放弃,重试参数形同虚设),于是报「仍被进程占用」,
//   而此时手动删(或等一秒再删)明明能删掉 —— 插件仓库文件越多,踩中的概率越大。
//   对策:改用异步 `fs.promises.rm`(同等条件下实测直接成功)+ 有界外圈重试;
//   顺带不再阻塞主进程(同步删 2.4 万项会卡住 UI 约 3 秒,异步最大卡顿仅几十毫秒)。
//
// 返回值一律带「删除后校验」:目录真的没了才算成功,失败时把真实错误码带回去,
// 由调用方如实报错 —— 既不假成功,也不再拿临时锁当永久占用。

import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

export interface RemoveResult {
  ok: boolean
  /** 失败时的真实原因(含 errno 码),供 UI 如实展示。 */
  error?: string
}

/**
 * 重试预算:最多 5 轮、每轮间隔 600ms(≈ 2.4 秒容忍窗口)。
 * 单次 `rm()` 刻意用 maxRetries:0 —— Node 内部的退避是「retryDelay × 第几次」线性增长,
 * 传大值会让一次调用不可预期地等几十秒(实测 maxRetries:10/retryDelay:500 会一直等到
 * 锁释放:3s 锁 → 3.0s、20s 锁 → 22.6s)。改成「内层不重试 + 外层定次重试」后,
 * 容忍时间可算、可解释:临时占用等约 2.4 秒,真占用到期如实报错。
 */
const MAX_TRIES = 5
const RETRY_GAP_MS = 600

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function errText(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code
  const msg = e instanceof Error ? e.message : String(e)
  return code ? `${code}: ${msg}` : msg
}

/** 光秃秃的链接(junction / symlink):只 unlink 链接本身,绝不深入目标目录。 */
function tryUnlinkLink(path: string): 'not-link' | 'ok' | 'error' {
  try {
    if (!lstatSync(path).isSymbolicLink()) return 'not-link'
    unlinkSync(path)
    return 'ok'
  } catch {
    return 'error'
  }
}

/**
 * 递归摘除目录内的符号链接 / junction(只摘链接,不进入目标)。
 * 用 dirent 判定类型:批量删大树时逐条 lstat 会拖慢主进程(2.4 万项 ≈ 1 秒)。
 */
export function removeLinksInside(dir: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
  } catch {
    return
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    let isLink = entry.isSymbolicLink()
    let isDir = entry.isDirectory()
    if (!isLink && !isDir && !entry.isFile()) {
      // 类型未知(个别文件系统/网络盘返回 DT_UNKNOWN):退回 lstat 判定,
      // 否则可能把 junction 当普通目录递归进去。
      try {
        const st = lstatSync(p)
        isLink = st.isSymbolicLink()
        isDir = !isLink && st.isDirectory()
      } catch {
        continue
      }
    }
    if (isLink) {
      try {
        unlinkSync(p)
      } catch {
        /* 占用中则留给删除后的校验如实报错 */
      }
      continue
    }
    if (isDir) removeLinksInside(p)
  }
}

/**
 * 删除目录(异步、带重试、删后校验)。
 * - 返回 { ok: true } = 目录确实已不存在(删除成功或本就不存在);
 * - 返回 { ok: false, error } = 确实残留,`error` 是最后一次的真实错误(如 EPERM)。
 * 临时占用会被等掉(最多约 2 秒),真正的持久占用才报失败。
 */
export async function removeDirSafe(dir: string, tries = MAX_TRIES, gapMs = RETRY_GAP_MS): Promise<RemoveResult> {
  if (!existsSync(dir)) return { ok: true }

  const link = tryUnlinkLink(dir)
  if (link === 'ok' || (link === 'error' && !existsSync(dir))) return { ok: true }
  if (link === 'error') return { ok: false, error: 'EPERM: 无法摘除该目录的符号链接/junction' }

  let error: string | undefined
  for (let i = 0; i < tries; i++) {
    // 每轮重摘:上轮若被占用而部分失败,可能留下未摘除的链接。
    removeLinksInside(dir)
    try {
      await rm(dir, { recursive: true, force: true })
      error = undefined
    } catch (e) {
      error = errText(e)
    }
    if (!existsSync(dir)) return { ok: true }
    if (i < tries - 1) await delay(gapMs)
  }
  return { ok: false, error }
}

/**
 * 同步版本:用于「不能 await」的内部自愈路径(启动前清残留等,失败只记日志)。
 * 语义与上面一致(摘链接 → rmSync → 校验),但**没有重试预算** —— 同步 rmSync 在
 * Windows 上不会重试,遇到临时占用会立刻失败。用户可见的删除请用异步版本。
 */
export function removeDirSafeSync(dir: string): boolean {
  if (!existsSync(dir)) return true
  const link = tryUnlinkLink(dir)
  if (link === 'ok' || (link === 'error' && !existsSync(dir))) return true
  removeLinksInside(dir)
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    /* 交给下面的存在性校验 */
  }
  if (!existsSync(dir)) return true
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 仍然失败 → 如实返回 false */
  }
  return !existsSync(dir)
}
