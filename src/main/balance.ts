// DeepSeek balance widget — reads the API key from dsh's own
// ~/.dsh/.credentials.yaml (DSH stores it there) and queries the DeepSeek
// balance endpoint via the main process's net.fetch (avoids CORS from the
// renderer). The key is only read in the main process, never persisted here
// or logged.

import { net } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from './config'
import { getActiveInstance, instanceDshHome } from './instances'
import { t } from './i18n'
import type { BalanceResult } from '../shared/types'

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

/**
 * Extract `DEEPSEEK_API_KEY: <value>` from the simple key: value credential file.
 * 按活动实例的 home 读 key:独立 home 复制了共享 key,独立实例读自己的;
 * 共享实例仍读 ~/.dsh。
 */
function readDshApiKey(): string | null {
  try {
    const raw = readFileSync(join(instanceDshHome(getActiveInstance()), '.credentials.yaml'), 'utf8')
    const m = raw.match(/^\s*DEEPSEEK_API_KEY\s*[:=]\s*["']?([^"'\r\n]+)["']?\s*$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export async function getBalance(): Promise<BalanceResult> {
  const key = readDshApiKey()
  if (!key) {
    return {
      ok: false,
      error: t('未找到 API Key — 请在 DSH 界面填写,或确认 ~/.dsh/.credentials.yaml 已配置。', 'No API Key found — fill it in the DSH UI, or check ~/.dsh/.credentials.yaml.')
    }
  }
  try {
    const res = await net.fetch(DEEPSEEK_BALANCE_URL, { headers: { Authorization: `Bearer ${key}` } })
    if (!res.ok) {
      return { ok: false, error: t(`余额接口返回 HTTP ${res.status}`, `Balance endpoint returned HTTP ${res.status}`) }
    }
    const json = (await res.json()) as {
      is_available?: boolean
      balance_infos?: Array<{
        currency?: string
        total_balance?: string
        granted_balance?: string
        topped_up_balance?: string
      }>
    }
    const info = json.balance_infos?.[0]
    if (!info) {
      return { ok: false, error: t('余额响应缺少 balance_infos', 'Balance response is missing balance_infos') }
    }
    return {
      ok: true,
      data: {
        currency: info.currency ?? 'CNY',
        total_balance: String(info.total_balance ?? ''),
        granted_balance: String(info.granted_balance ?? ''),
        topped_up_balance: String(info.topped_up_balance ?? ''),
        is_available: json.is_available ?? false
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
