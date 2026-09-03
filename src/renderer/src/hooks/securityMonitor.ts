import { useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import { computeStatus } from '../lib/securityRisk'

/** 共享的安全监控状态:整体风险等级(0绿 1黄 2橙 3红)+ 风险事件数。 */
export interface SecurityMonitorState {
  level: number
  count: number
}

// 模块级单例:多个组件(安全页、侧边栏弹窗)共用一次轮询。
// 常量快照:风险未变化时 current 保持同一引用 —— getSnapshot 稳定是
// useSyncExternalStore 不空转的前提。
const IDLE: SecurityMonitorState = { level: 0, count: 0 }
let current: SecurityMonitorState = IDLE
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false

function emit(): void {
  for (const l of listeners) l()
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function refresh(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const [events, whitelist] = await Promise.all([
      api.securityList(),
      api.securityGetWhitelist()
    ])
    const next = computeStatus(events, whitelist)
    // 只在风险等级/计数真正变化时才替换快照并通知。
    // 若每次都换新对象 emit,会把「3 秒轮询」放大成死循环:
    // emit → 重渲染 → subscribe 重建 → 重订阅 → 立刻 refresh → emit…
    if (next.level !== current.level || next.count !== current.count) {
      current = next
      emit()
    }
  } catch {
    /* 网络/轮询失败静默忽略 */
  } finally {
    inFlight = false
  }
}

/** 有监听者时才开始轮询;最后一个监听者退订后停掉,避免后台空转。 */
function startPolling(): void {
  if (timer) return
  void refresh()
  timer = setInterval(() => void refresh(), 3000)
}

/** 模块级稳定引用:useSyncExternalStore 依 subscribe 的身份判断要不要重订阅,
 *  每次渲染新建 subscribe 会让 React 反复退订/重订,进而反复触发 refresh。 */
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  startPolling()
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) stopPolling()
  }
}

/** 订阅共享安全监控状态(每 3s 轮询,仅在变化时通知)。 */
export function useSecurityMonitor(): SecurityMonitorState {
  return useSyncExternalStore(subscribe, () => current)
}
