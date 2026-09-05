import { useEffect, useRef, useState } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useI18n } from '../i18n'
import { PluginMatrixSection } from './Plugins'
import { SkillMatrixSection } from '../components/SkillTab'
import { McpMatrixSection } from '../components/McpTab'
import { ExtDrawer, type ExtKind } from '../components/ExtDrawer'
import type { McpPreset } from '../components/McpPresets'

/**
 * 抽屉拖宽松手后的“最小停留宽度”(px):停在中间区间(<内容区 85% 且 >15%)时宽度至少回到 300;
 * 拖到 ≤ 内容区 15% 会直接关闭抽屉(不经过该下限)。
 */
const DRAWER_MIN = 300

/**
 * 扩展聚合页(统一后):单页 = 顶栏(标题 + 三路分段开关)+ 主面板(本地管理矩阵)。
 *
 * 布局:主矩阵永远占满整个内容区,右侧市场抽屉以**绝对定位悬浮叠层**盖在上面
 * (不再把矩阵挤窄)。抽屉宽度可拖(左缘 ~8px 竖向拖拽区);松手时宽度 ≥ 内容区 85%
 * 自动平滑展开到全宽,≤ 内容区 15% 直接关闭,中间则停回当前宽度。抽屉 open 时点击其
 * 左侧未被盖住的矩阵区域也会收回抽屉。闭合时右缘中部显示一个竖向柔和小凸钮。
 */
export function Extensions(): JSX.Element {
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const [kind, setKindState] = useState<ExtKind>(() => {
    try {
      const saved = localStorage.getItem('dsh-launcher-ext-tab')
      return saved === 'skills' || saved === 'mcp' || saved === 'plugins' ? saved : 'plugins'
    } catch {
      return 'plugins'
    }
  })
  const [open, setOpen] = useState(false)
  // 抽屉当前宽度(px);0 = 尚未开启过。
  const [drawerW, setDrawerW] = useState(0)
  // 正在拖宽:拖拽中关掉 transition,让抽屉贴着指针走。
  const [dragging, setDragging] = useState(false)
  // 抽屉里发生安装/改动后自增,以 key 强制主矩阵重挂载 → 立即刷新数据。
  const [refreshTick, setRefreshTick] = useState(0)
  // 右侧 MCP「一键使用」点添加 → 预填 MCP 新建弹窗。
  const [mcpDraft, setMcpDraft] = useState<{ preset: McpPreset; token: number } | null>(null)

  // 主面板 wrapper:所有宽度测量都以它为准(resize / 开启 / 按下拖拽时取 clientWidth)。
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const setKind = (k: ExtKind): void => {
    setKindState(k)
    try {
      localStorage.setItem('dsh-launcher-ext-tab', k)
    } catch {
      /* 忽略 */
    }
    // 离开 MCP 类目时丢弃预置草稿,避免切回时旧 token 触发弹窗。
    if (k !== 'mcp') setMcpDraft(null)
  }

  const words: Record<ExtKind, { zh: string; en: string }> = {
    plugins: { zh: '插件', en: 'Plugins' },
    skills: { zh: '技能', en: 'Skills' },
    mcp: { zh: 'MCP', en: 'MCP' }
  }
  /** 闭合把手上竖向文案,随当前三路类目变化。 */
  const marketLabel: Record<ExtKind, string> = {
    plugins: L('插件市场', 'Plugin market'),
    skills: L('技能市场', 'Skill market'),
    mcp: L('MCP 一键使用', 'MCP presets')
  }

  const matrixKey = `${kind}-${refreshTick}`

  const contentWidth = (): number => wrapperRef.current?.clientWidth ?? 0

  /** 正常开启的默认宽度 = min(460, 内容区宽 * 0.62)。 */
  const defaultDrawerWidth = (): number => {
    const cw = contentWidth()
    if (cw <= 0) return 460
    return Math.min(460, Math.round(cw * 0.62))
  }

  const openDrawer = (): void => {
    setDrawerW(defaultDrawerWidth())
    setOpen(true)
  }

  const closeDrawer = (): void => {
    setOpen(false)
    setDragging(false)
    dragRef.current = null
  }

  // 内容区尺寸变化(窗口 resize)时,把已开的抽屉收回到新宽度内。
  useEffect(() => {
    if (!open) return
    const onResize = (): void => {
      const cw = contentWidth()
      if (cw > 0) setDrawerW((w) => Math.min(Math.max(DRAWER_MIN, w), cw))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  // --- 拖宽:pointerdown 记录起始宽与起始 clientX;move 跟随指针(clamp [0, wrapper.clientWidth],
  // 结束按内容区比例判定:≥85% 平滑全展开,≤15% 直接关闭,中间 clamp 回 [DRAWER_MIN, cw])。 ---
  const dragStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const cw = contentWidth()
    const cur = drawerW > 0 ? drawerW : defaultDrawerWidth()
    dragRef.current = { startX: e.clientX, startW: Math.max(DRAWER_MIN, Math.min(cur, cw || cur)) }
    setDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 指针捕获不可用则忽略(仍有 pointerup) */
    }
  }

  const dragMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    const cw = contentWidth()
    if (!d || cw <= 0) return
    const next = d.startW + (d.startX - e.clientX)
    // 拖拽中允许收窄到接近 0(不先 clamp 到 DRAWER_MIN),否则 300 的下限会挡住
    // 「≤ 内容区 15% 自动关闭」;下限只在松手后的“中间停留”处重新生效。
    setDrawerW(Math.max(0, Math.min(next, cw)))
  }

  const dragEnd = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    setDragging(false)
    const cw = contentWidth()
    if (cw <= 0) return
    const raw = d.startW + (d.startX - e.clientX)
    // 拖到/落到内容区 85% 以上 → 自动平滑展开为全宽(占满内容区)。
    // 先恢复 transition,下一帧再改宽度,保证「平滑」生效。
    if (raw >= cw * 0.85) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setDrawerW(cw))
      })
    } else if (raw <= cw * 0.15) {
      // 拖到/落到内容区 15% 以下 → 直接关闭抽屉(宽度归 0)。
      closeDrawer()
    } else {
      // 中间区间:停回允许的最小停留宽度。
      setDrawerW(Math.max(DRAWER_MIN, Math.min(raw, cw)))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏:左侧可点选的「插件 / 技能 / MCP 管理」;点哪个切到哪个(不再有右上开关) */}
      {/* 高度固定并靠底部对齐,避免三词字号动画时整页上下晃动;字号向页面标题看齐 */}
      <div className="flex h-[56px] shrink-0 items-end gap-2 overflow-hidden border-b px-5 pb-2" style={{ borderColor: 'var(--border)' }}>
        {(['plugins', 'skills', 'mcp'] as const).map((k, idx) => {
          const active = kind === k
          return (
            <span key={k} className="flex items-center gap-2">
              {idx > 0 && <span className="select-none text-[13px]" style={{ color: 'var(--muted)' }}>/</span>}
              <button
                className="cursor-pointer transition-all duration-150"
                style={{
                  color: active ? '#fff' : 'var(--muted)',
                  fontSize: active ? 18 : 14,
                  fontWeight: active ? 600 : 500,
                  lineHeight: 1,
                  whiteSpace: 'nowrap'
                }}
                onClick={() => setKind(k)}
              >
                {lang === 'en' ? words[k].en : words[k].zh}
              </button>
            </span>
          )
        })}
        <span className="flex select-none items-center gap-1.5">
          <span className="text-[14px] font-medium leading-none" style={{ color: 'var(--muted)' }}>
            {L('管理', 'Manager')}
          </span>
        </span>
        <span className="flex-1" />
      </div>

      {/* 主面板 wrapper:矩阵占满,抽屉以 absolute 叠在上面 */}
      <div ref={wrapperRef} className="relative min-h-0 flex-1">
        {/* 主矩阵:永远占满整个内容区(不被抽屉挤窄) */}
        <div className="h-full min-w-0 overflow-y-auto px-5 py-4">
          {kind === 'plugins' ? (
            <PluginMatrixSection key={matrixKey} />
          ) : kind === 'skills' ? (
            <SkillMatrixSection key={matrixKey} />
          ) : (
            <McpMatrixSection key={matrixKey} presetDraft={mcpDraft} />
          )}
        </div>

        {/* 抽屉 open 时:左侧未被抽屉盖住的矩阵区盖一层透明点击层,点击即收回抽屉。
            宽度 = wrapper − drawerW,天然不越过抽屉本体(把手的 4px 外露由更高 z 兜住);
            z-20 高于矩阵、低于抽屉(z-30)与拖拽把手(z-40),不影响抽屉/把手自身交互。 */}
        {open && (
          <div
            className="absolute inset-y-0 left-0 z-20"
            style={{ width: `calc(100% - ${drawerW}px)` }}
            onClick={closeDrawer}
            aria-hidden="true"
          />
        )}

        {/* 悬浮叠层抽屉:absolute right-0,盖在矩阵上方 */}
        {open && (
          <div
            className="absolute inset-y-0 right-0 z-30 flex flex-col overflow-hidden rounded-l-xl border-l"
            style={{
              width: drawerW,
              background: 'var(--panel)',
              borderColor: 'var(--border)',
              boxShadow: '0 0 22px rgba(0,0,0,0.18)',
              transition: dragging ? 'none' : 'width 0.2s ease-out'
            }}
          >
            <ExtDrawer
              key={kind}
              kind={kind}
              onClose={closeDrawer}
              onChanged={() => setRefreshTick((v) => v + 1)}
              onUseMcpPreset={(p) => {
                setKind('mcp')
                setMcpDraft({ preset: p, token: Date.now() })
              }}
            />
          </div>
        )}

        {/* 抽屉左缘 ~8px 竖向拖拽区(cursor-col-resize),改变宽度 */}
        {open && (
          <div
            className="absolute inset-y-0 z-40 cursor-col-resize"
            style={{
              width: 8,
              left: `calc(100% - ${drawerW}px - 4px)`,
              transition: dragging ? 'none' : 'left 0.2s ease-out',
              touchAction: 'none'
            }}
            onPointerDown={dragStart}
            onPointerMove={dragMove}
            onPointerUp={dragEnd}
            onPointerCancel={dragEnd}
            title={L('拖动调整抽屉宽度', 'Drag to resize the drawer')}
          />
        )}

        {/* 闭合时:右缘中部的竖向柔和把手(圆角小凸钮,不带整条) */}
        {!open && (
          <button
            onClick={openDrawer}
            title={L(`打开${marketLabel[kind]}`, `Open ${marketLabel[kind]}`)}
            className="absolute right-0 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center rounded-md border px-2 py-2 transition-opacity hover:opacity-80"
            style={{
              background: 'color-mix(in srgb, var(--panel) 86%, transparent)',
              color: 'var(--accent)',
              borderColor: 'var(--border)',
              boxShadow: '-1px 0 8px rgba(0,0,0,0.14)'
            }}
          >
            <span className="select-none text-[26px] font-bold leading-none">‹</span>
            <span
              className="mt-1 text-[12.5px] font-semibold leading-[1.3]"
              style={{ writingMode: 'vertical-rl', textOrientation: 'upright' }}
            >
              {marketLabel[kind]}
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
