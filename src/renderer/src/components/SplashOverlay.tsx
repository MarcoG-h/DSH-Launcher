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
//
// Stuck-splash recovery: on some machines the splash never leaves — the video
// either never starts (cold asar read / first-run antivirus scan stalling it at
// 0s) or plays to the last frame and freezes there because `ended` never fires
// (some mp4s expose a non-finite duration, so Chromium never ends the stream).
// A progress watchdog reacts to whichever happened: once the video has started
// and then stops advancing, it has hit the final frame, so we exit immediately;
// if it never started at all, we refresh the window once (the media file is then
// usually cached and plays) and, if a reloaded attempt is still stuck, skip the
// splash so the launcher is never held hostage.
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
// Playback-progress watchdog (samples the media clock every tick).
const STALL_TICK_MS = 1000
// Media clock frozen for this long after playback started ⇒ the video reached
// its last frame without `ended` firing — exit rather than wait forever.
const END_STALL_MS = 1200
// No playback at all for this long ⇒ the video never started. Refresh the
// window once (the file is usually in cache by then); if a reloaded attempt is
// still stuck, skip the splash.
const NEVER_STARTED_MS = 4000
const MAX_RELOADS = 1
// sessionStorage key tracking reloads — survives location.reload(), cleared on
// window close, so every fresh launch gets a full attempt at the splash.
const ATTEMPT_KEY = 'dsh:splash-stuck'

export function SplashOverlay({ onDone }: { onDone: () => void }): JSX.Element | null {
  const { config } = useHarness()
  const [theme] = useTheme()
  const [exiting, setExiting] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const doneRef = useRef(false)
  // Reloaded attempts persist across location.reload() so we don't loop forever.
  const attemptsRef = useRef(Number(sessionStorage.getItem(ATTEMPT_KEY) ?? '0'))
  const dark = theme === 'dark'
  const enabled = config?.splashEnabled ?? true

  const finish = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    // A reloaded attempt that eventually completed (or was skipped) resets the
    // counter so the next app launch gets a fresh attempt.
    sessionStorage.removeItem(ATTEMPT_KEY)
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
    let lastTickTime = 0
    let started = false
    let stallMs = 0
    let notStartedMs = 0
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
    // Watchdog for the two "stuck splash" failure modes (see header comment).
    // It samples the media clock itself (not timeupdate, which can pause at a
    // frame boundary), so a frozen video is detected within a tick or two.
    const watchdog = setInterval(() => {
      if (done || doneRef.current || v.ended || v.error) return
      const now = v.currentTime
      if (now > 0) started = true
      if (now === lastTickTime) {
        stallMs += STALL_TICK_MS
        if (!started) notStartedMs += STALL_TICK_MS
      } else {
        lastTickTime = now
        stallMs = 0
        notStartedMs = 0
      }
      // Played to the end but froze on the last frame (ended never fired): exit.
      if (started && stallMs >= END_STALL_MS) {
        startExit()
        return
      }
      // Never started at all: refresh the window once, skip if it persists.
      if (!started && notStartedMs >= NEVER_STARTED_MS) {
        const next = attemptsRef.current + 1
        sessionStorage.setItem(ATTEMPT_KEY, String(next))
        if (next <= MAX_RELOADS) {
          console.error('[splash] video never started, refreshing window to unstick it')
          location.reload()
        } else {
          console.error('[splash] video still stuck after reload, skipping splash')
          finish()
        }
      }
    }, STALL_TICK_MS)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('error', finish)
      v.removeEventListener('ended', finish)
      clearTimeout(safety)
      clearInterval(watchdog)
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
