import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useHarness, statusLabel } from '../hooks/useHarness'
import { PlayIcon, StopIcon, RefreshIcon, ExternalIcon, PowerIcon } from '../lib/icons'
import { LogConsole } from '../components/LogConsole'
import { StatusPill } from '../components/StatusPill'
import { BalanceCard } from '../components/BalanceCard'

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function Meta({ label, value, mono = true }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      <span className={`text-[13px] font-medium ${mono ? 'mono' : ''}`} style={{ color: 'var(--text)' }}>
        {value}
      </span>
    </div>
  )
}

export function Dashboard(): JSX.Element {
  const { state, log, start, stop, restart, openUi, actionError, dismissError } = useHarness()
  const [busy, setBusy] = useState<'start' | 'stop' | 'restart' | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const status = state?.status ?? 'stopped'
  // Anything but a clean idle/error shows the stop control (incl. external).
  const running = status !== 'stopped' && status !== 'error'
  const canRestart = status === 'running' || status === 'external'
  const canOpenUi = status === 'running' || status === 'external'
  const startedAt = state?.startedAt ?? null

  const doStart = async (): Promise<void> => {
    setBusy('start')
    await start()
    setBusy(null)
  }
  const doStop = async (): Promise<void> => {
    setBusy('stop')
    await stop()
    setBusy(null)
  }
  const doRestart = async (): Promise<void> => {
    setBusy('restart')
    await restart()
    setBusy(null)
  }

  return (
    <div className="p-5 space-y-5">
      {/* Status hero */}
      <div className="panel p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h2 className="text-[18px] font-semibold">DeepSeek Harness</h2>
              <StatusPill status={status} />
            </div>
            <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
              profile <span className="mono">{state?.profile}</span> · {statusLabel(status)}
            </p>
            {state?.lastError && (
              <p className="text-[12.5px]" style={{ color: 'var(--err)' }}>
                上次错误: {state.lastError}
              </p>
            )}
            {status === 'external' && (
              <p className="text-[12.5px]" style={{ color: 'var(--warn)' }}>
                检测到外部实例在运行 — 点「停止」将其终止后,即可由本应用接管启动。
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!running ? (
              <button className="btn btn-primary" disabled={busy !== null} onClick={() => void doStart()}>
                <PlayIcon /> {busy === 'start' ? '启动中…' : '启动'}
              </button>
            ) : (
              <button className="btn btn-danger" disabled={busy !== null} onClick={() => void doStop()}>
                <StopIcon /> {busy === 'stop' ? '停止中…' : status === 'external' ? '停止(外部)' : '停止'}
              </button>
            )}
            <button className="btn btn-ghost" disabled={busy !== null || !canRestart} onClick={() => void doRestart()}>
              <RefreshIcon /> {busy === 'restart' ? '重启中…' : '重启'}
            </button>
            <button
              className="btn btn-ghost"
              disabled={!canOpenUi}
              onClick={() => void openUi()}
              title="http://127.0.0.1:{port}"
            >
              <ExternalIcon /> 打开 Web UI
            </button>
          </div>
        </div>

        {actionError && (
          <div
            className="mt-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[12.5px]"
            style={{
              borderColor: 'var(--err)',
              color: 'var(--err)',
              background: 'color-mix(in srgb, var(--err) 8%, transparent)'
            }}
          >
            <span>{actionError}</span>
            <button onClick={dismissError} className="shrink-0 text-[12px] opacity-70 hover:opacity-100">
              ✕
            </button>
          </div>
        )}

        {/* Meta grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 mt-5 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
          <Meta label="进程 PID" value={state?.pid ? String(state.pid) : '—'} />
          <Meta label="端口" value={String(state?.port ?? 3080)} />
          <Meta label="运行时长" value={startedAt ? fmtUptime(Math.max(0, now - startedAt)) : '—'} />
          <Meta label="就绪" value={state?.ready ? '✔ 是' : '—'} />
          <Meta label="退出码" value={state && state.exitCode != null ? String(state.exitCode) : '—'} />
          <Meta label="数据目录" value={state?.profile ?? '—'} mono={false} />
        </div>
      </div>

      {/* Balance widget */}
      <BalanceCard />

      {/* Log console */}
      <LogConsole lines={log} />

      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
        <PowerIcon />
        启动与停止均会控制 dsh 进程树;窗口关闭时按设置决定是否随应用退出。
      </div>
    </div>
  )
}
