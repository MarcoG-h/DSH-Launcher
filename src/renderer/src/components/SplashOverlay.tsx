// Startup splash, played INSIDE the main window (no second window): a
// full-window white (light theme) or black (dark theme) backdrop with the
// whale-lightbulb video centered (public/splash.mp4). Near the end the video
// fades out (both themes — no zoom), then the overlay unmounts and the
// launcher UI is revealed. Turning the animation off in Settings makes this
// component call onDone() immediately.
//
// The video carries a static AI watermark in its bottom-right corner (source
// y≈905-935 of 960). Instead of re-encoding, we clip the bottom strip: the
// video is rendered objectFit:cover inside a slightly shorter overflow:hidden
// box, top-aligned (objectPosition '50% 0%'), so only the bottom is cut off.
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useHarness } from '../hooks/useHarness'
import { useTheme } from '../hooks/useTheme'

const SIZE = 460
// Display px clipped off the bottom of the video to hide the AI watermark
// (~6.3% of the video height; the whale's body ends well above the cut).
const CROP_BOTTOM = 29
const CROP_H = SIZE - CROP_BOTTOM
// How early (seconds) before the video ends we start the exit animation.
const LIGHT_LEAD = 1.15
const DARK_LEAD = 0.55
// Exit animation length, matching the CSS transition durations below.
const LIGHT_EXIT_MS = 1000
const DARK_EXIT_MS = 520
// Absolute fallback: never leave the overlay hanging if the timeline stalls.
const SAFETY_MS = 5400

export function SplashOverlay({ onDone }: { onDone: () => void }): JSX.Element | null {
  const { config } = useHarness()
  const [theme] = useTheme()
  const [exiting, setExiting] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const doneRef = useRef(false)
  const dark = theme === 'dark'
  const enabled = config?.splashEnabled ?? true

  const finish = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    onDone()
  }

  useEffect(() => {
    if (!enabled) {
      finish()
      return
    }
    const v = videoRef.current
    if (!v) {
      finish()
      return
    }
    let done = false
    const startExit = (): void => {
      if (done) return
      done = true
      setExiting(true)
      setTimeout(finish, dark ? DARK_EXIT_MS : LIGHT_EXIT_MS)
    }
    const onTime = (): void => {
      if (done) return
      const lead = dark ? DARK_LEAD : LIGHT_LEAD
      if (Number.isFinite(v.duration) && v.currentTime >= v.duration - lead) startExit()
    }
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('error', finish)
    v.addEventListener('ended', finish)
    const safety = setTimeout(() => {
      if (!done) startExit()
    }, SAFETY_MS)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('error', finish)
      v.removeEventListener('ended', finish)
      clearTimeout(safety)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, dark])

  if (!enabled) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: dark ? '#000000' : '#ffffff',
        opacity: dark && exiting ? 0 : 1,
        transition: dark ? 'opacity 0.5s ease-in' : 'none'
      }}
    >
      {/* The clip box: same width as the video, shorter by the crop strip.
          The video stays a fixed SIZE×SIZE, top-left anchored, so only the
          bottom CROP_BOTTOM px is clipped away (the watermark) — the left
          edge is never touched. In dark theme the radius clips the corners. */}
      <div
        style={{
          width: SIZE,
          height: CROP_H,
          overflow: 'hidden',
          borderRadius: dark ? 28 : 0,
          position: 'relative'
        }}
      >
        <video
          ref={videoRef}
          src="splash.mp4"
          muted
          autoPlay
          playsInline
          preload="auto"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: SIZE,
            height: SIZE,
            objectFit: 'contain',
            display: 'block',
            opacity: exiting ? 0 : 1,
            transition: dark ? 'none' : 'opacity 0.95s ease-in'
          }}
        />
      </div>
    </div>
  )
}
