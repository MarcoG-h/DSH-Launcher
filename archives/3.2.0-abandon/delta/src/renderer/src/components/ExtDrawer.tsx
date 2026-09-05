import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { api, type InstalledPlugin, type LocalPlugin } from '../lib/api'
import { useI18n } from '../i18n'
import { ChevronIcon } from '../lib/icons'
import { MarketTab } from './MarketTab'
import { McpPresetPanel, type McpPreset } from './McpPresets'
import { SkillMarketPanel } from './SkillTab'
import { PluginInstallForm } from '../pages/Plugins'

export type ExtKind = 'plugins' | 'skills' | 'mcp'

interface Props {
  kind: ExtKind
  onClose: () => void
  /** 抽屉里发生安装/改动后调用:让左侧主矩阵立刻重新加载。 */
  onChanged: () => void
  /** MCP 预置「添加」:把预置填进 MCP 新建 Modal。 */
  onUseMcpPreset: (p: McpPreset) => void
}

/** 插件市场抽屉内容:URL 直装 + 插件市场(MarketTab)。 */
function PluginMarketPanel({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [local, setLocal] = useState<LocalPlugin[]>([])
  const [extra, setExtra] = useState<string[]>([])

  const refresh = useCallback(async () => {
    try {
      const [l, m] = await Promise.all([api.listPlugins(), api.listPluginMatrix()])
      setInstalled(l.installed ?? [])
      setLocal(l.local ?? [])
      setExtra(Object.keys(m?.cells ?? {}))
    } catch {
      /* 非致命:市场自身会用刷新按钮重试 */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="space-y-3">
      <PluginInstallForm onInstalled={onChanged} />
      <MarketTab
        installed={installed}
        local={local}
        extraInstalledNames={extra}
        onRefresh={() => {
          void refresh()
          onChanged()
        }}
      />
    </div>
  )
}

/** 右侧市场抽屉:内容随当前三路开关类目即时切换。 */
export function ExtDrawer({ kind, onClose, onChanged, onUseMcpPreset }: Props): JSX.Element {
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const title =
    kind === 'plugins'
      ? L('插件市场', 'Plugin market')
      : kind === 'skills'
        ? L('技能市场', 'Skill market')
        : L('MCP 一键使用', 'MCP presets')

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--panel)' }}>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
        <span className="text-[13px] font-semibold">{title}</span>
        <button
          className="btn btn-ghost btn-sm ml-auto !px-2"
          title={L('收起', 'Close')}
          onClick={onClose}
        >
          <ChevronIcon dir="right" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {kind === 'plugins' ? (
          <PluginMarketPanel onChanged={onChanged} />
        ) : kind === 'skills' ? (
          <SkillMarketPanel onChanged={onChanged} />
        ) : (
          <McpPresetPanel onUse={onUseMcpPreset} />
        )}
      </div>
    </div>
  )
}
