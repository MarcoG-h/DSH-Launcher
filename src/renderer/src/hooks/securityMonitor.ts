import { useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import { computeStatus } from '../lib/securityRisk'

/** 共享的安全监控状态:整体风险等级(0绿 1黄 2橙 3红)+ 风险事件数。 */
export interface SecurityMonitorState {
  level: number
  count: number
}

// 模块级单例:多个组件(安全页、侧边栏弹窗)共用一次轮询。
let current: SecurityMonitorState = { level: 0, count: 0 }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function emit(): void {
  for (const l of listeners) l()
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 有监听者时才开始轮询;最后一个监听者退订后停掉,避免后台空转。 */
function startPolling(): void {
  if (timer) return
  const refresh = async (): Promise<void> => {
    try {
      const [events, whitelist] = await Promise.all([
        api.securityList(),
        api.securityGetWhitelist()
      ])
      current = computeStatus(events, whitelist)
      emit()
    } catch {
      /* 网络/轮询失败静默忽略 */
    }
  }
  void refresh()
  timer = setInterval(() => void refresh(), 3000)
}

/** 订阅共享安全监控状态(每 3s 轮询)。 */
export function useSecurityMonitor(): SecurityMonitorState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      startPolling()
      return () => {
        listeners.delete(cb)
        if (listeners.size === 0) stopPolling()
      }
    },
    () => current
  )
}
