// DeepSeek balance widget — reads the API key (config override or dsh's own
// ~/.dsh/.credentials.yaml) and queries the balance endpoint via the main
// process's net.fetch (avoids CORS from the renderer). The key is only read in
// the main process, never persisted here or logged.

import { net } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getActiveApiPreset, getConfig } from './config'
import { t } from './i18n'
import type { BalanceResult } from '../shared/types'

/** Extract `DEEPSEEK_API_KEY: <value>` from the simple key: value credential file. */
function readDshApiKey(): string | null {
  try {
    const raw = readFileSync(join(getConfig().dshHome, '.credentials.yaml'), 'utf8')
    const m = raw.match(/^\s*DEEPSEEK_API_KEY\s*[:=]\s*["']?([^"'\r\n]+)["']?\s*$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export async function getBalance(): Promise<BalanceResult> {
  const cfg = getConfig()
  const preset = getActiveApiPreset()
  // Local / self-hosted models (Ollama, LM Studio, vLLM…) need no API key and
  // expose no balance endpoint — skip the query entirely instead of surfacing a
  // misleading "API key is valid" / "no key" result.
  if (preset.local) {
    return { ok: true, local: true, provider: preset.name }
  }
  const url =
    (preset.balanceUrl ?? '').trim() ||
    (preset.baseUrl ? `${preset.baseUrl.replace(/\/+$/, '')}/user/balance` : '')
  if (!url) {
    return {
      ok: false,
      provider: preset.name,
      error: t('该厂商未配置余额接口 — 可在 设置 → API 切换 里填写 balanceUrl。', 'This provider has no balance URL configured — set one under Settings → API switch.')
    }
  }
  // Key priority: preset key → global override → dsh credentials file.
  const key = (preset.apiKey ?? '').trim() || (cfg.deepseekApiKey ?? '').trim() || readDshApiKey()
  if (!key) {
    return {
      ok: false,
      provider: preset.name,
      error: t('未找到 API Key — 请在该预设或设置中填写,或确认 ~/.dsh/.credentials.yaml 已配置。', 'No API Key found — set it in this preset or in Settings, or check ~/.dsh/.credentials.yaml.')
    }
  }
  try {
    const res = await net.fetch(url, { headers: { Authorization: `Bearer ${key}` } })
    if (!res.ok) {
      return { ok: false, provider: preset.name, error: t(`余额接口返回 HTTP ${res.status}`, `Balance endpoint returned HTTP ${res.status}`) }
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
      return { ok: false, provider: preset.name, error: t('余额响应缺少 balance_infos', 'Balance response is missing balance_infos') }
    }
    return {
      ok: true,
      provider: preset.name,
      data: {
        currency: info.currency ?? 'CNY',
        total_balance: String(info.total_balance ?? ''),
        granted_balance: String(info.granted_balance ?? ''),
        topped_up_balance: String(info.topped_up_balance ?? ''),
        is_available: json.is_available ?? false
      }
    }
  } catch (err) {
    return { ok: false, provider: preset.name, error: err instanceof Error ? err.message : String(err) }
  }
}
