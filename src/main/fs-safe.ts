// 安全目录删除 —— 绕开 Electron 主进程的一个坑。
//
// 2026-09-05 实测(Electron 43.4.0):主进程里同步 `fs.rmSync(dir, {recursive:true,force:true})`
// 遇到**目录树内含 junction / 符号链接**时会「静默成功但什么都不删」——不抛异常、目录原样
// 保留。纯 Node 无此问题;`fs.rm` / `fs.promises.rm` 也正常。受影响的是所有用 rmSync 删除
// 含链接目录的路径:插件库删除、实例删除(workspace / profile / 独立 home)、探针卸载等。
//
// 对策:先递归 unlink 目录内的链接(junction 不跟随、只删链接本身),再 rmSync,最后
// **校验目录确实消失**;返回 false 表示没删掉,由调用方如实报错 —— 不再有「假成功」。

import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 光秃秃的链接(junction / symlink)直接 unlink 即可,绝不深入其目标目录。 */
function unlinkIfLink(path: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/** 递归清掉目录内的符号链接/junction(先 unlink 链接本身,再交给 rmSync 删实体)。 */
export function removeLinksInside(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const p = join(dir, name)
    let isLink = false
    try {
      isLink = lstatSync(p).isSymbolicLink()
    } catch {
      continue
    }
    if (isLink) {
      try { unlinkSync(p) } catch { /* 占用中则留给校验如实报错 */ }
      continue
    }
    let isDir = false
    try {
      isDir = lstatSync(p).isDirectory()
    } catch {
      continue
    }
    if (isDir) removeLinksInside(p)
  }
}

/**
 * 删除目录并校验结果。返回 true = 目录已不存在(删除成功或本就不存在);
 * false = 确实残留(通常被进程占用),调用方应如实报错而非假成功。
 */
export function removeDirSafe(dir: string): boolean {
  if (!existsSync(dir)) return true
  // 目标本身是链接:只摘链接,绝不进入目标目录。
  if (unlinkIfLink(dir)) return !existsSync(dir)
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
    /* 二次仍失败 → 如实返回 false */
  }
  return !existsSync(dir)
}
