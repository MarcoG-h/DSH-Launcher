// Tray status light: subscribes to the running dsh's /api event streams (mux +
// host WebSockets, plus a session.list baseline) and folds them into a
// green/yellow/red light for the system tray —
//   green  = dsh is running normally
//   yellow = the agent is waiting on the user (a tool approval or a question)
//   red    = an agent error / stream error
//   off    = dsh is not up (or the light is disabled)
//
// The /api gateway trusts loopback requests by default, so connecting from the
// launcher (also on this machine) needs no token or credential. If the API is
// unavailable (an older dsh without the event streams) we degrade to a
// port-only green light rather than flashing something misleading.

import { net } from 'electron'
import { onEvent } from './bus'
import { getConfig } from './config'
import type { LauncherEvent } from '../shared/types'

export type DshLight = 'off' | 'green' | 'yellow' | 'red'

let light: DshLight = 'off'
let running = false
let port = 3080
let connected = false
let pending = 0
let errors = 0
let degraded = false
let hostWs: WebSocket | null = null
let muxWs: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// The tray light reflects the *active* instance; every instance's status is
// tracked so switching instances flips the light without waiting for a new event.
const states: Record<string, { status: string; port: number }> = {}
let activeId = getConfig().activeInstanceId || 'default'

const listeners = new Set<(light: DshLight) => void>()

/** Subscribe to the tray-light state. The callback fires immediately and on change. */
export function onDshLight(cb: (light: DshLight) => void): () => void {
  listeners.add(cb)
  cb(light)
  return () => {
    listeners.delete(cb)
  }
}

export function getDshLight(): DshLight {
  return light
}

function setLight(next: DshLight): void {
  if (next === light) return
  light = next
  for (const l of listeners) l(light)
}

function recompute(): void {
  let next: DshLight
  if (!running) {
    next = 'off'
  } else if (errors > 0) {
    next = 'red'
  } else if (pending > 0) {
    next = 'yellow'
  } else if (connected || degraded) {
    next = 'green'
  } else {
    next = 'off'
  }
  setLight(next)
}

// ---- WebSocket plumbing ----------------------------------------------------

function openWs(
  path: string,
  onFrame: (payload: { type: string }) => void,
  onOpen: () => void,
  onDead: () => void,
): WebSocket | null {
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    ws.onopen = () => onOpen()
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return
      try {
        const msg = JSON.parse(ev.data) as { payload?: { type?: string } }
        const payload = msg?.payload
        if (payload && typeof payload.type === 'string') {
          onFrame({ type: payload.type })
        }
      } catch {
        /* drop malformed frame */
      }
    }
    ws.onerror = () => { /* onclose always follows */ }
    ws.onclose = () => onDead()
    return ws
  } catch {
    return null
  }
}

function cleanup(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  try {
    hostWs?.close()
  } catch {
    /* ignore */
  }
  try {
    muxWs?.close()
  } catch {
    /* ignore */
  }
  hostWs = null
  muxWs = null
  connected = false
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (running) void connect()
  }, 2000)
}

// ---- Frame handling ----------------------------------------------------------

function handleHostFrame(p: { type: string }): void {
  switch (p.type) {
    case 'host/agent-error':
    case 'stream/error':
      errors++
      recompute()
      break
    default:
      break
  }
}

function handleMuxFrame(p: { type: string }): void {
  switch (p.type) {
    case 'approval/requested':
    case 'question/requested':
      pending++
      recompute()
      break
    case 'approval/resolved':
    case 'question/resolved':
      pending = Math.max(0, pending - 1)
      recompute()
      break
    case 'stream/error':
      errors++
      recompute()
      break
    default:
      break
  }
}

// ---- Lifecycle --------------------------------------------------------------

async function connect(): Promise<void> {
  if (!running) return
  cleanup()

  // API availability probe: a refused/404 POST means this dsh predates the
  // event API, so fall back to a port-only green light.
  degraded = false
  try {
    const res = await net.fetch(`http://127.0.0.1:${port}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'host.describe',
        payload: {}
      })
    })
    degraded = !res.ok
  } catch {
    degraded = true
  }

  // Baseline: which sessions are running right now. The mux stream also replays
  // still-pending approval/question frames on open, so pending settles from the
  // first frames without extra bookkeeping.
  try {
    const res = await net.fetch(`http://127.0.0.1:${port}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'session.list',
        payload: {}
      })
    })
    if (res.ok) {
      const json = (await res.json()) as { result?: { ok?: boolean; value?: { items?: Array<{ running?: boolean }> } } }
      degraded = degraded || !(json.result?.ok === true)
    }
  } catch {
    degraded = true
  }

  const markConnected = (): void => {
    connected = true
    recompute()
  }
  const markDead = (): void => {
    if (!running) return
    connected = false
    scheduleReconnect()
  }

  hostWs = openWs('/api/events.host', handleHostFrame, markConnected, markDead)
  muxWs = openWs('/api/events.mux', handleMuxFrame, markConnected, markDead)
  recompute()
}

function stop(): void {
  running = false
  cleanup()
  recompute()
}

/** Reconnect the WS feed to whatever the active instance is now doing. */
function sync(): void {
  const st = states[activeId]
  const status = st?.status
  const up = status === 'running' || status === 'external'
  if (up && running && st && st.port !== port) {
    // The active instance re-picked its port (port 0 each start) — reconnect.
    stop()
    running = true
    port = st.port
    pending = 0
    errors = 0
    void connect()
  } else if (up && !running) {
    running = true
    port = st?.port || getConfig().port || 3080
    pending = 0
    errors = 0
    void connect()
  } else if (!up && running) {
    stop()
  }
}

/** Wire the light to the harness lifecycle; call once at startup. */
export function init(): void {
  onEvent((e: LauncherEvent) => {
    if (e.type === 'instances') {
      activeId = e.activeInstanceId
      sync()
    } else if (e.type === 'state') {
      states[e.state.instanceId] = { status: e.state.status, port: e.state.port }
      if (e.state.instanceId === activeId) sync()
    }
  })
}
