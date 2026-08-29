import { useRef } from 'react'

/**
 * 弹窗遮罩「点关闭」防误触:只有鼠标**按下也起始于遮罩**时才允许点击关闭。
 *
 * 背景问题:弹窗内容里拖选文字时,若鼠标拖出内容、松开落在遮罩上,浏览器会把
 * click 派发到遮罩(按下与松开位置的共同祖先)→ 误关弹窗。
 *
 * 用法:
 *   const backdrop = useBackdropClose(onClose)
 *   <div className="modal-backdrop" onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick}>
 *     <div onMouseDown={backdrop.contentMouseDown}>…内容…</div>
 *   </div>
 */
export function useBackdropClose(onClose: () => void): {
  onMouseDown: () => void
  onClick: () => void
  contentMouseDown: () => void
} {
  const pressRef = useRef(false)
  return {
    // 按下发生在遮罩上 → 允许该次点击关闭
    onMouseDown: (): void => { pressRef.current = true },
    onClick: (): void => {
      if (pressRef.current) {
        pressRef.current = false
        onClose()
      }
    },
    // 按下发生在内容里 → 即使松开落在遮罩上也不关闭
    contentMouseDown: (): void => { pressRef.current = false }
  }
}
