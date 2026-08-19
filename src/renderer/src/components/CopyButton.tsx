import { useEffect, useRef, useState } from 'react'
import { CopyIcon } from '../lib/icons'
import { useI18n } from '../i18n'

/**
 * 一键复制按钮:点击把 `text` 写入剪贴板,成功后短暂显示 ✓。
 * 全局 body 禁用了文本选择(`user-select: none`),所以报错文案除拖选复制外,
 * 还需要这类显式复制按钮。复制内容是原样文本,不含样式。
 */
export function CopyButton({ text, title }: { text: string; title?: string }): React.JSX.Element {
  const { t } = useI18n()
  const [ok, setOk] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const copy = (): void => {
    const write = async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // Electron 渲染层兜底:临时 textarea + execCommand('copy')
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try {
          document.execCommand('copy')
        } catch {
          /* 忽略 — 复制失败也不阻塞 UI */
        }
        ta.remove()
      }
    }
    void write()
    setOk(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOk(false), 1200)
  }

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm shrink-0"
      onClick={copy}
      title={title ?? t('common.copy')}
    >
      {ok ? <span className="text-[12px] leading-none">✓</span> : <CopyIcon />}
    </button>
  )
}
