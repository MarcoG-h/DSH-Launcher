import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { api, type LauncherConfig } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { TaskConsole } from '../components/TaskConsole'
import { RefreshIcon, PowerIcon } from '../lib/icons'

function Field({ label, value, onChange, mono = true, hint }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; hint?: string }): JSX.Element {
  return (
    <div>
      <label className="label">{label}</label>
      <input className={`input ${mono ? 'mono' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>{hint}</p>
      )}
    </div>
  )
}

export function Settings(): JSX.Element {
  const { config, saveConfig, tasks } = useHarness()
  const [form, setForm] = useState<Partial<LauncherConfig>>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (config) setForm((f) => ({ ...f, ...config }))
  }, [config])

  const set = (k: keyof LauncherConfig) => (v: string | number | boolean | string[]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setSaved(false)
  }

  const doSave = async (): Promise<void> => {
    await saveConfig(form as Partial<LauncherConfig>)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const repairTask = tasks['repair']
  const buildTask = tasks['build']

  return (
    <div className="p-5 space-y-5 max-w-[900px]">
      <h2 className="text-[18px] font-semibold">设置</h2>

      {/* Paths */}
      <div className="panel p-5 space-y-4">
        <h3 className="section-title">路径与启动</h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Harness 仓库" value={form.harnessRepo ?? ''} onChange={set('harnessRepo')} hint="dsh CLI 源码所在目录" />
          <Field label="DSH_HOME" value={form.dshHome ?? ''} onChange={set('dshHome')} hint="profiles/sessions/storages 所在目录" />
          <Field label="本地插件目录" value={form.pluginDir ?? ''} onChange={set('pluginDir')} hint="扫描可用插件的目录(如 DSH-Plugin)" />
          <div>
            <label className="label">端口</label>
            <input className="input mono" type="number" value={form.port ?? 3080} onChange={(e) => set('port')(Number(e.target.value) || 3080)} />
          </div>
          <Field label="profile" value={form.profile ?? ''} onChange={set('profile')} hint="启动的 profile 名(默认 web)" />
          <Field label="node 可执行文件" value={form.nodePath ?? ''} onChange={set('nodePath')} />
        </div>
        <Field
          label="启动命令(launchArgs,空格分隔)"
          value={(form.launchArgs ?? []).join(' ')}
          onChange={(v) => set('launchArgs')(v.split(/\s+/).filter(Boolean))}
          hint={`最终: ${form.nodePath ?? 'node'} ${[...(form.launchArgs ?? []), form.profile ?? 'web'].join(' ')}`}
        />
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="构建命令" value={form.buildCmd ?? ''} onChange={set('buildCmd')} />
          <Field label="pnpm 可执行文件" value={form.pnpm ?? ''} onChange={set('pnpm')} />
        </div>
        <div className="flex flex-wrap gap-6 pt-1">
          <label className="flex items-center gap-2 text-[13px] cursor-pointer">
            <input
              type="checkbox"
              checked={form.stopOnQuit ?? true}
              onChange={(e) => set('stopOnQuit')(e.target.checked)}
            />
            关闭应用时停止 Harness 进程
          </label>
          <label className="flex items-center gap-2 text-[13px] cursor-pointer">
            <input
              type="checkbox"
              checked={form.autoOpenUi ?? true}
              onChange={(e) => set('autoOpenUi')(e.target.checked)}
            />
            启动就绪后自动打开 Web UI
          </label>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">启动超时(毫秒)</label>
            <input
              className="input mono"
              type="number"
              value={form.startupTimeoutMs ?? 90000}
              onChange={(e) => set('startupTimeoutMs')(Number(e.target.value) || 90000)}
            />
          </div>
        </div>
        <div className="pt-1">
          <button className="btn btn-primary" onClick={() => void doSave()}>
            {saved ? '已保存 ✓' : '保存设置'}
          </button>
        </div>
      </div>

      {/* Maintenance */}
      <div className="panel p-5 space-y-4">
        <h3 className="section-title">维护</h3>
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          依赖缺失(如上次的 <span className="mono">zod</span> 报错)或源码改动后,需要先在仓库内重新安装 / 构建,再启动。
        </p>
        <div className="flex gap-2">
          <button className="btn btn-ghost" disabled={busy !== null} onClick={() => void run('repair', api.repairDeps)}>
            <RefreshIcon /> 修复依赖 (pnpm install)
          </button>
          <button className="btn btn-ghost" disabled={busy !== null} onClick={() => void run('build', api.rebuild)}>
            <PowerIcon /> 重新构建 (pnpm run build)
          </button>
        </div>
        {repairTask && (
          <div>
            <TaskConsole task={repairTask} />
          </div>
        )}
        {buildTask && (
          <div>
            <TaskConsole task={buildTask} />
          </div>
        )}
      </div>
    </div>
  )
}
