import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { api, type ApiPreset, type LauncherConfig } from '../lib/api'
import { useHarness } from '../hooks/useHarness'
import { TaskConsole } from '../components/TaskConsole'
import { DownloadIcon, RefreshIcon, PowerIcon, PlusIcon, TrashIcon } from '../lib/icons'

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
  const { config, saveConfig, tasks, refresh } = useHarness()
  const [form, setForm] = useState<Partial<LauncherConfig>>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [dlBusy, setDlBusy] = useState(false)
  const [dlDone, setDlDone] = useState(false)
  const [rtBusy, setRtBusy] = useState<'install' | 'update' | null>(null)
  const [rtDone, setRtDone] = useState(false)
  // API presets are edited in a dedicated local state (nested array in config).
  const [presets, setPresets] = useState<ApiPreset[]>([])
  const [activeId, setActiveId] = useState('deepseek-official')

  useEffect(() => {
    if (config) {
      setForm((f) => ({ ...f, ...config }))
      setPresets((config.apiPresets ?? []).map((p) => ({ ...p })))
      setActiveId(config.activeApiPresetId ?? 'deepseek-official')
    }
  }, [config])

  const set = (k: keyof LauncherConfig) => (v: string | number | boolean | string[]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setSaved(false)
  }

  const doSave = async (): Promise<void> => {
    await saveConfig({
      ...(form as Partial<LauncherConfig>),
      apiPresets: presets,
      activeApiPresetId: activeId
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  // --- API preset editing (local state, persisted together with doSave) ---
  const updatePreset = (id: string, patch: Partial<ApiPreset>): void => {
    setPresets((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
    setSaved(false)
  }
  const setActivePreset = (id: string): void => {
    setActiveId(id)
    setSaved(false)
  }
  const removePreset = (id: string): void => {
    setPresets((ps) => {
      const next = ps.filter((p) => p.id !== id)
      if (activeId === id) setActiveId(next[0]?.id ?? '')
      return next
    })
    setSaved(false)
  }
  const addPreset = (): void => {
    const id = `custom-${Date.now()}`
    setPresets((ps) => [...ps, { id, name: '新厂商', baseUrl: '', balanceUrl: '', apiKey: '' }])
    setSaved(false)
  }

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const doDownload = async (): Promise<void> => {
    setDlBusy(true)
    setDlDone(false)
    try {
      const r = await api.downloadHarness()
      await refresh() // pull the auto-configured paths into the form
      setDlDone(r.ok)
    } finally {
      setDlBusy(false)
    }
  }

  const doInstallRuntime = async (): Promise<void> => {
    setRtBusy('install')
    setRtDone(false)
    try {
      const r = await api.installRuntime()
      await refresh()
      setRtDone(r.ok)
    } finally {
      setRtBusy(null)
    }
  }

  const doUpdateRuntime = async (): Promise<void> => {
    setRtBusy('update')
    try {
      await api.updateRuntime()
      await refresh()
    } finally {
      setRtBusy(null)
    }
  }

  const isBundled = form.installMode === 'bundled'
  const downloadTask = tasks['download:harness']
  const repairTask = tasks['repair']
  const buildTask = tasks['build']
  const runtimeTask = tasks['runtime:install']
  const updateTask = tasks['runtime:update']

  return (
    <div className="p-5 space-y-5 max-w-[900px]">
      <h2 className="text-[18px] font-semibold">设置</h2>

      {/* Quick offline deployment (bundled runtime) */}
      <div className="panel p-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 space-y-1">
            <h3 className="section-title">快速离线部署</h3>
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              一键装好便携 Node + npm + pnpm + <span className="mono">@deepseek-ai/dsh</span>,部署完成后即可
              <strong style={{ color: 'var(--text)' }}>直接启动使用 dsh</strong>——目标机器无需安装 Node.js、无需
              源码,全程离线可用。这是给普通使用者的推荐方式。
            </p>
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              当前模式:
              <span
                className="badge ml-2"
                style={
                  isBundled
                    ? { color: 'var(--accent)', background: 'var(--accent-soft)' }
                    : { color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }
                }
              >
                {isBundled ? '内置运行环境 · 免装 Node' : '源码版 · 使用本机 Node'}
              </span>
            </p>
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              「更新内置 dsh」只升级内置配套插件,不会覆盖 <span className="mono">~/.dsh</span> 里的第三方插件与
              <span className="mono"> cordis.patch.yml</span> 手动条目。
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button className="btn btn-primary shrink-0" disabled={rtBusy !== null} onClick={() => void doInstallRuntime()}>
              <DownloadIcon /> {rtBusy === 'install' ? '部署中…' : '快速离线部署'}
            </button>
            <button className="btn btn-ghost shrink-0" disabled={rtBusy !== null} onClick={() => void doUpdateRuntime()}>
              <RefreshIcon /> {rtBusy === 'update' ? '更新中…' : '更新内置 dsh'}
            </button>
          </div>
        </div>
        {rtDone && (
          <p className="text-[12.5px]" style={{ color: 'var(--ok)' }}>
            ✔ 部署完成 — 已自动切换为内置模式并回填路径,回到「控制台」点击启动即可直接使用 dsh。
          </p>
        )}
        {runtimeTask && <TaskConsole task={runtimeTask} />}
        {updateTask && <TaskConsole task={updateTask} />}
        <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          注意:runtimeRoot 与 DSH_HOME 需位于同一磁盘(内置插件通过 junction 链接)。当前 runtimeRoot =
          <span className="mono"> {form.runtimeRoot || '—'}</span>
        </p>
      </div>

      {/* Source-mode download — advanced, kept small */}
      <details className="panel p-4 space-y-3">
        <summary
          className="cursor-pointer select-none text-[12px] font-medium"
          style={{ color: 'var(--muted)' }}
        >
          ⚠ 源码版:下载 / 更新 Harness 源码(高级 — 不建议新手使用)
        </summary>
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--warn)' }}>
          仅当你需要调试或改动 Harness 源码时才点这里。普通使用请用上面的「快速离线部署」,不需要源码。
        </p>
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          会克隆 / 更新 <span className="mono">{form.harnessRepoUrl}</span> 到{' '}
          <span className="mono">{form.harnessRepo}</span> 并安装依赖、自动配置路径。需要本机已有 Node 与 pnpm;
          若目录已存在则执行 <span className="mono">git pull</span> + <span className="mono">pnpm install</span>。
        </p>
        <button className="btn btn-ghost btn-sm" disabled={dlBusy} onClick={() => void doDownload()}>
          <DownloadIcon /> {dlBusy ? '下载中…' : '下载 / 更新源码'}
        </button>
        {dlDone && (
          <p className="text-[12px]" style={{ color: 'var(--ok)' }}>
            ✔ 完成 — 路径已自动配置。
          </p>
        )}
        {downloadTask && <TaskConsole task={downloadTask} />}
        {repairTask && <TaskConsole task={repairTask} />}
      </details>

      {/* Paths */}
      <div className="panel p-5 space-y-4">
        <h3 className="section-title">路径与启动</h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">运行模式</label>
            <select className="input" value={form.installMode ?? 'bundled'} onChange={(e) => set('installMode')(e.target.value)}>
              <option value="bundled">内置运行环境(免装 Node)</option>
              <option value="source">源码版(本机 Node + 源码仓库)</option>
            </select>
          </div>
          <Field label="运行环境目录 runtimeRoot" value={form.runtimeRoot ?? ''} onChange={set('runtimeRoot')} hint="便携 Node + 内置 dsh 的安装位置" />
          <Field label="Harness 仓库" value={form.harnessRepo ?? ''} onChange={set('harnessRepo')} hint="dsh CLI 源码所在目录(源码版用)" />
          <Field label="Harness 仓库 URL" value={form.harnessRepoUrl ?? ''} onChange={set('harnessRepoUrl')} hint="一键下载 / 更新源码时使用的克隆地址" />
          <Field label="DSH_HOME" value={form.dshHome ?? ''} onChange={set('dshHome')} hint="profiles/sessions/storages 所在目录" />
          <Field label="本地插件目录" value={form.pluginDir ?? ''} onChange={set('pluginDir')} hint="扫描可用插件的目录(如 DSH-Plugin)" />
          <Field label="DeepSeek API Key(可选)" value={form.deepseekApiKey ?? ''} onChange={set('deepseekApiKey')} mono={false} hint="余额小部件专用;留空则读取 ~/.dsh/.credentials.yaml" />
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

      {/* API vendor presets */}
      <div className="panel p-5 space-y-4">
        <div className="space-y-1">
          <h3 className="section-title">API 切换</h3>
          <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            在多个 AI 厂商预设之间一键切换。切换后需重启 dsh 生效 —— 启动时会自动注入该厂商的地址和 API
            Key(同时用于余额查询),无需再去 DSH 界面填。预设没填 Key 时,沿用 <span className="mono">~/.dsh/.credentials.yaml</span> 里已有的。
          </p>
        </div>
        <div className="space-y-3">
          {presets.length === 0 && (
            <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
              暂无预设,点击下方「添加预设」创建一个。
            </p>
          )}
          {presets.map((p) => {
            const isActive = p.id === activeId
            return (
              <div
                key={p.id}
                className="border rounded-lg p-3 space-y-2.5"
                style={{
                  borderColor: isActive ? 'var(--accent)' : 'var(--border)',
                  background: isActive ? 'var(--accent-soft)' : 'transparent'
                }}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <input
                      className="input mono"
                      value={p.name}
                      placeholder="厂商名称"
                      onChange={(e) => updatePreset(p.id, { name: e.target.value })}
                      style={{ width: 180 }}
                    />
                    {isActive && (
                      <span className="badge" style={{ color: '#fff', background: 'var(--accent)' }}>
                        当前
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {!isActive && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setActivePreset(p.id)}>
                        设为当前
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => removePreset(p.id)}
                      disabled={presets.length <= 1}
                    >
                      <TrashIcon /> 删除
                    </button>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="label">模型 API 地址 (baseUrl)</label>
                    <input
                      className="input mono"
                      value={p.baseUrl}
                      placeholder="https://api.deepseek.com"
                      onChange={(e) => updatePreset(p.id, { baseUrl: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="label">余额接口 (balanceUrl,可留空)</label>
                    <input
                      className="input mono"
                      value={p.balanceUrl}
                      placeholder="https://api.deepseek.com/user/balance"
                      onChange={(e) => updatePreset(p.id, { balanceUrl: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label">API Key(注入 dsh 供模型调用 + 余额查询)</label>
                    <input
                      className="input mono"
                      type="password"
                      value={p.apiKey ?? ''}
                      placeholder="sk-…"
                      onChange={(e) => updatePreset(p.id, { apiKey: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost btn-sm" onClick={addPreset}>
            <PlusIcon /> 添加预设
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => void doSave()}>
            {saved ? '已保存 ✓' : '保存设置'}
          </button>
        </div>
      </div>

      {/* Maintenance — source mode only */}
      {!isBundled && (
        <div className="panel p-5 space-y-4">
          <h3 className="section-title">维护(源码版)</h3>
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
      )}
    </div>
  )
}
