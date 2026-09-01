/**
 * pnpm 兼容层 —— 从 dsh-market 移植:识别不同 pnpm major 在 dsh profile 目录里的
 * 失败模式,并给出可操作的恢复/提示。安装/卸载用 dsh plugin 命令转发到 pnpm,
 * 但 pnpm 的失败诊断需要在这里单独识别(dsh 的包装行不说明原因)。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 为 `dsh plugin <add|remove> …` 决定 argv。
 * pnpm 9 在 workspace 根目录 add 必须带 -w(#17,#20);所有 pnpm major 在非 workspace
 * 目录带 -w 都会失败。所以仅当 profile 有 pnpm-workspace.yaml 时注入 -w。
 */
export function pluginArgsFor(profileDirPath: string, pluginArgs: string[]): string[] {
  if (pluginArgs[0] !== 'add' && pluginArgs[0] !== 'remove') return pluginArgs
  if (!existsSync(join(profileDirPath, 'pnpm-workspace.yaml'))) return pluginArgs
  return [pluginArgs[0], '-w', ...pluginArgs.slice(1)]
}

/** 一个被识别出的 pnpm 失败,带面向用户的可操作说明。 */
export interface PnpmFailure {
  code: 'adding-to-root' | 'not-a-workspace' | 'hoist-pattern-diff' | 'pnpm-missing' | 'release-age-violation'
    | 'ignored-builds' | 'git-prepare-not-allowed' | 'git-network' | 'llama-binary' | 'fetch-404'
    | 'transient-network' | 'fetch-timeout' | 'unexpected-store'
  /** 双语的、可操作的提示(替代原始报错墙)。 */
  message: string
  /** true = 重跑 `pnpm install` 是文档记载的恢复方式。 */
  recoverable: boolean
}

/** 瞬时网络失败——值得且只值得自动重试一次(#83)。 */
export function isTransientPnpmFailure(output: string): boolean {
  return /ERR_PNPM_FETCH_5\d\d|ERR_PNPM_META_FETCH_FAIL|FetchError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network timeout/i.test(output)
}

/** pnpm 单次请求 fetch 超时(大 tarball 在慢网上的典型失败)。 */
export function isFetchTimeoutFailure(output: string): boolean {
  return /operation was aborted due to timeout|TimeoutError|error \(23\)/i.test(output)
}

/** 把一次失败的 pnpm 运行输出映射到已知失败模式;未识别则返回 null(原样展示)。 */
export function classifyPnpmFailure(output: string): PnpmFailure | null {
  if (output.includes('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF')) {
    return {
      code: 'hoist-pattern-diff',
      recoverable: true,
      message: '这个 profile 的 node_modules 是旧版 pnpm 创建的,与当前 pnpm 的默认配置不兼容,已自动重建后重试 / this profile\'s node_modules was created by a different pnpm major; it was rebuilt and retried',
    }
  }
  if (output.includes('ERR_PNPM_UNEXPECTED_STORE')) {
    const linked = /currently linked from the store at "([^"]+)"/.exec(output)?.[1]
    const wanted = /wants to use the store at "([^"]+)"/.exec(output)?.[1]
    const detail = linked !== undefined && wanted !== undefined
      ? `\n  node_modules → ${linked}\n  pnpm 现在想用 / pnpm now wants → ${wanted}`
      : ''
    return {
      code: 'unexpected-store',
      recoverable: false,
      message: `这个 profile 的 node_modules 链接到的 pnpm store,和当前 pnpm 默认使用的不是同一个,pnpm 因此拒绝所有安装与卸载。${detail}\n在 profile 目录执行一次 \`pnpm install --store-dir <上面第一个路径>\` 重新链接即可(必要时先退出 dsh) / this profile\'s node_modules is linked to a different pnpm store, so pnpm refuses every install and uninstall.${detail}\nRelink by running \`pnpm install --store-dir <the first path above>\` once in the profile directory`,
    }
  }
  if (output.includes('ERR_PNPM_ADDING_TO_ROOT')) {
    return {
      code: 'adding-to-root',
      recoverable: false,
      message: 'pnpm 拒绝在 workspace 根目录安装(缺少 -w)。这是 launcher 的 bug,请更新到最新版 / pnpm refused to add at a workspace root (missing -w); this is a launcher bug — please update',
    }
  }
  if (/--workspace-root may only be used inside a workspace/i.test(output)) {
    return {
      code: 'not-a-workspace',
      recoverable: false,
      message: 'profile 目录不是 pnpm workspace,却传入了 -w。这是 launcher 的 bug,请更新到最新版 / -w was passed but the profile is not a pnpm workspace; this is a launcher bug — please update',
    }
  }
  // 刚发布的插件版本触发 pnpm 的安全等待期检查,阻塞对锁文件的任何改动。
  if (output.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
    || output.includes('ERR_PNPM_NO_MATURE_MATCHING_VERSION')) {
    return {
      code: 'release-age-violation',
      recoverable: false,
      message: '这个 profile 里有一个刚发布不久的插件版本,pnpm 的安全等待期检查因此拒绝了本次改动(即使改的是别的插件)。已自动放行重试一次;若仍失败请稍后再试 / a recently-published plugin version trips pnpm\'s fresh-release safety check, blocking any change; it was retried once with a one-shot bypass — if it still fails, try again later',
    }
  }
  if (output.includes('ERR_PNPM_IGNORED_BUILDS')) {
    return {
      code: 'ignored-builds',
      recoverable: false,
      message: '有依赖需要执行构建脚本,被 pnpm 默认拦截。请在「插件管理」里允许构建脚本后重试 / a dependency needs to run build scripts, which pnpm blocks by default — allow build scripts and retry',
    }
  }
  if (output.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED')) {
    return {
      code: 'git-prepare-not-allowed',
      recoverable: false,
      message: '这个 git 插件需要在安装时执行构建脚本,被 pnpm 默认拦截。允许构建脚本后重试即可 / this git-hosted plugin needs to run its build script at install time, which pnpm blocks by default — allow build scripts and retry',
    }
  }
  // GitHub 直装插件(`github:owner/repo` / `git+…`)在拉取仓库时网络失败时,git 的
  // stderr(fatal: …)原样透出,匹配不到上面的 pnpm 报错码(isTransientPnpmFailure
  // 的正则也只认 pnpm 的 FETCH_5xx / 节点层网络词)。若不单独识别,这类插件首次失败
  // 就「一击即死」,没有任何重试。这里归为网络类,由调用方自动重试一次。
  if (/(?:fatal: unable to access|fatal: could not read from remote repository|fatal: unable to look up|fatal: could not resolve host|could not resolve host: github|failed to connect to (?:codeload\.)?github\.com|github\.com port \d+: connection refused|the remote end hung up unexpectedly|early eof|rpc failed)/i.test(output)) {
    return {
      code: 'git-network',
      recoverable: false,
      message: '拉取 GitHub 仓库失败(无法连上 GitHub)。已自动重试一次;若仍失败,说明当前网络到 GitHub 不通,稍后再试 / failed to fetch the GitHub repo (cannot reach GitHub); retried once — if it still fails the network to GitHub is blocked, try again later',
    }
  }
  // node-llama-cpp 等模型引擎依赖:postinstall 要从 GitHub Releases 下载大体积二进制。
  // 下载失败会让 pnpm 把整个 add 判失败,容易误以为插件坏了。单独识别并重试,
  // 提示真正的问题(引擎二进制下载,不是插件本身)。
  if (/(?:failed to (?:download|find|get).*?llama|llama.*?failed to (?:download|find))/i.test(output)) {
    return {
      code: 'llama-binary',
      recoverable: false,
      message: '下载 llama 引擎二进制失败(该插件依赖本地模型引擎,二进制从 GitHub Releases 下载)。已自动重试一次;若仍失败,通常是网络到 GitHub 不通,稍后再试 / failed to download the llama engine binary (the plugin needs a local model engine whose binary is fetched from GitHub Releases); retried once — if it still fails the network to GitHub is likely blocked',
    }
  }
  if (output.includes('ERR_PNPM_FETCH_404')) {
    const pkg = /GET\s+\S*\/([^/\s]+):/.exec(output)?.[1].replace(/%2[Ff]/g, '/')
    const zh = pkg === undefined ? '' : `(${pkg})`
    const en = pkg === undefined ? '' : ` (${pkg})`
    return {
      code: 'fetch-404',
      recoverable: false,
      message: `有一个依赖在 registry 上不存在${zh},pnpm 因此拒绝任何安装操作。它可能是之前失败操作残留在 profile package.json 里的幽灵依赖(可手动删除该行),也可能是需要登录的私有包 / a dependency cannot be resolved from the registry${en}; it may be a ghost entry left in the profile\'s package.json by an earlier failed operation, or a private package needing registry credentials`,
    }
  }
  if (isTransientPnpmFailure(output)) {
    return {
      code: 'transient-network',
      recoverable: false,
      message: '拉取依赖时网络临时失败(不一定是正在装的插件——安装会重放整个依赖树,任何一个既有依赖抖动都会中断)。已自动重试一次仍失败,请稍后再试 / a transient network failure while fetching dependencies; one automatic retry failed too — please try again shortly',
    }
  }
  if (isFetchTimeoutFailure(output)) {
    return {
      code: 'fetch-timeout',
      recoverable: false,
      message: '下载超时:这个插件的安装包较大(github 源会下载整个仓库)或网络较慢,pnpm 默认的单次请求 60 秒限制不够用。已用更长的超时自动重试一次;若仍失败请稍后再试 / download timed out: this plugin ships a large tarball or your network is slow; retried once with a longer timeout — if it still fails, try again later',
    }
  }
  if (output.includes('pnpm not found on PATH')) {
    return {
      code: 'pnpm-missing',
      recoverable: false,
      message: '找不到 pnpm,请先在「设置 → 运行环境」一键安装运行环境 / pnpm is not on PATH — install the runtime from Settings first',
    }
  }
  return null
}
