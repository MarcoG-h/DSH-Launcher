// The floating whale orb, rendered in its own tiny WebContentsView (loaded
// with `?orb=1`) layered above the embedded DSH view. Pressing and holding the
// ball arms it for dragging; moving it drags the orb around the window. A short
// tap without movement is a click — the orb returns to the top-left and the
// launcher menu expands.
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { api } from '../lib/api'
import whaleIcon from '../assets/whale.png'

// Hold ~this long without moving to "arm" the ball for dragging.
const LONG_PRESS_MS = 300
// Any movement beyond this before the hold elapses also turns into a drag.
const DRAG_THRESHOLD = 6

export default function OrbWidget(): JSX.Element {
  const ball = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const start = useRef({ x: 0, y: 0, t: 0 })
  const moved = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [armed, setArmed] = useState(false)

  // The orb view is transparent; the page must not paint its own background.
  useEffect(() => {
    const html = document.documentElement
    const prevHtml = html.style.background
    const prevBody = document.body.style.background
    html.style.background = 'transparent'
    document.body.style.background = 'transparent'
    return () => {
      html.style.background = prevHtml
      document.body.style.background = prevBody
    }
  }, [])

  const clearTimer = (): void => {
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 只响应左键:右键不启动拖拽/点击流程(否则右键松开会触发 orbClick 展开菜单),
    // 交给 webContents 的原生 context-menu 弹快捷实例切换列表。
    if (e.button !== 0) return
    e.preventDefault()
    ball.current?.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, y: e.clientY, t: Date.now() }
    moved.current = false
    setArmed(false)
    setDragging(false)
    // The orb page's viewport is exactly the orb view, so client coords are
    // already view coordinates — the grab point the main process needs.
    api.orbDragStart(e.clientX, e.clientY)
    clearTimer()
    timer.current = window.setTimeout(() => {
      timer.current = null
      setArmed(true)
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!moved.current) {
      const dx = e.clientX - start.current.x
      const dy = e.clientY - start.current.y
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return
      moved.current = true
      clearTimer()
      setArmed(false)
      setDragging(true)
    }
    api.orbDragMove(e.screenX, e.screenY)
  }

  const finish = (clicked: boolean): void => {
    clearTimer()
    if (clicked) api.orbClick()
    else api.orbDragEnd()
    setArmed(false)
    setDragging(false)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    try {
      ball.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    const held = Date.now() - start.current.t
    finish(!moved.current && held < LONG_PRESS_MS)
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>): void => {
    try {
      ball.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    clearTimer()
    setArmed(false)
    setDragging(false)
  }

  return (
    <div className="w-full h-full flex items-center justify-center" style={{ background: 'transparent' }}>
      <div
        ref={ball}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className="w-11 h-11 rounded-full flex items-center justify-center overflow-hidden select-none"
        style={{
          background: '#fff',
          border: '1px solid rgba(128,128,128,0.35)',
          boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
          cursor: dragging ? 'grabbing' : armed ? 'grab' : 'pointer',
          transform: armed || dragging ? 'scale(1.08)' : undefined,
          transition: 'transform 0.12s ease',
          touchAction: 'none'
        }}
      >
        <img
          src={whaleIcon}
          alt=""
          draggable={false}
          className="w-8 h-8 object-contain"
          style={{ pointerEvents: 'none' }}
        />
      </div>
    </div>
  )
}
