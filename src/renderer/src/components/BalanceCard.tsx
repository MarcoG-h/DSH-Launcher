import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { api, type BalanceData } from '../lib/api'
import { RefreshIcon } from '../lib/icons'

/** DeepSeek balance widget — manual + 5-minute auto refresh. */
export function BalanceCard(): JSX.Element {
  const [data, setData] = useState<BalanceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true)
    const r = await api.getBalance()
    if (r.ok && r.data) {
      setData(r.data)
      setError(null)
    } else {
      setError(r.error ?? '获取余额失败')
      setData(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load(true)
    const t = setInterval(() => void load(true), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [load])

  const availableColor = data?.is_available ? 'var(--ok)' : 'var(--warn)'

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="section-title">DeepSeek 余额</h3>
          {data && (
            <span
              className="badge"
              style={{
                color: availableColor,
                background: `color-mix(in srgb, ${availableColor} 14%, transparent)`
              }}
            >
              <span className="badge-dot" style={{ background: availableColor }} />
              {data.is_available ? '可用' : '不可用'}
            </span>
          )}
        </div>
        <button className="btn btn-ghost btn-sm shrink-0" onClick={() => void load()} title="刷新余额">
          <RefreshIcon /> {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error ? (
        <p className="mt-2.5 text-[12.5px]" style={{ color: 'var(--warn)' }}>
          {error}
        </p>
      ) : data ? (
        <div className="mt-3 grid grid-cols-3 gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
              总额
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
              赠送
            </div>
            <div className="mono text-[16px] font-semibold mt-0.5" style={{ color: 'var(--text)' }}>
              {data.granted_balance}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
              充值
            </div>
            <div className="mono text-[16px] font-semibold mt-0.5" style={{ color: 'var(--text)' }}>
              {data.topped_up_balance}
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-2.5 text-[12.5px]" style={{ color: 'var(--muted)' }}>
          {loading ? '加载中…' : '—'}
        </p>
      )}
    </div>
  )
}
