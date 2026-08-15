import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { api, type BalanceData } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { useI18n } from '../i18n'
import { RefreshIcon } from '../lib/icons'

/** Balance widget — manual + 5-minute auto refresh, follows the active API preset. */
export function BalanceCard(): JSX.Element {
  const { config, saveConfig } = useHarness()
  const { t } = useI18n()
  const [data, setData] = useState<BalanceData | null>(null)
  const [provider, setProvider] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const presets = config?.apiPresets ?? []
  const activeId = config?.activeApiPresetId

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true)
    const r = await api.getBalance()
    setProvider(r.provider ?? null)
    if (r.ok && r.data) {
      setData(r.data)
      setError(null)
    } else {
      setError(r.error ?? t('balance.fetchFailed'))
      setData(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load(true)
    const t = setInterval(() => void load(true), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [load])

  // One-click vendor switch: persist the new active preset, then refresh balance.
  const switchPreset = async (id: string): Promise<void> => {
    await saveConfig({ activeApiPresetId: id })
    await load(true)
  }

  const availableColor = data?.is_available ? 'var(--ok)' : 'var(--warn)'

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="section-title">{provider ?? 'API'} {t('balance.title')}</h3>
          {data && (
            <span
              className="badge"
              style={{
                color: availableColor,
                background: `color-mix(in srgb, ${availableColor} 14%, transparent)`
              }}
            >
              <span className="badge-dot" style={{ background: availableColor }} />
              {data.is_available ? t('balance.available') : t('balance.unavailable')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {presets.length > 0 && (
            <select
              className="input"
              value={activeId ?? ''}
              onChange={(e) => void switchPreset(e.target.value)}
              title={t('balance.switchTitle')}
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-ghost btn-sm shrink-0" onClick={() => void load()} title={t('balance.refreshTitle')}>
            <RefreshIcon /> {loading ? t('balance.refreshing') : t('balance.refresh')}
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-2.5 text-[12.5px]" style={{ color: 'var(--warn)' }}>
          {error}
        </p>
      ) : data ? (
        <div className="mt-3 grid grid-cols-3 gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
              {t('balance.total')}
            </div>
            <div className="mono text-[20px] font-semibold mt-0.5" style={{ color: 'var(--text)' }}>
              {data.total_balance}{' '}
              <span className="text-[12px] font-normal" style={{ color: 'var(--muted)' }}>
                {data.currency}
              </span>
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
              {t('balance.granted')}
            </div>
            <div className="mono text-[16px] font-semibold mt-0.5" style={{ color: 'var(--text)' }}>
              {data.granted_balance}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
              {t('balance.toppedUp')}
            </div>
            <div className="mono text-[16px] font-semibold mt-0.5" style={{ color: 'var(--text)' }}>
              {data.topped_up_balance}
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-2.5 text-[12.5px]" style={{ color: 'var(--muted)' }}>
          {loading ? t('balance.loading') : '—'}
        </p>
      )}
    </div>
  )
}
