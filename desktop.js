// dsh-whale-bongo · desktop supervisor
//
// Starts a small local Electron helper that hosts the widget outside the DSH
// page.  Electron is not bundled.  The helper exposes a loopback-only HTTP
// bridge for config and key events, so its stdin stays untouched (reading
// stdin in the Electron main process can prevent the first window from
// finishing its load on Windows).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HELPER_MAIN = path.join('runtime', 'electron-helper', 'main.js')
const WINDOW_WIDTH = 620
const WINDOW_HEIGHT = 780

function electronExecutable() {
  const explicit = process.env.DSH_WHALE_ELECTRON || process.env.DSH_PET_ELECTRON
  if (explicit && existsSync(explicit)) return explicit
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const candidates = [
    path.join(home, 'electron-whale', '43.3.0', exe),
    path.join(home, 'electron-whale', 'current', exe),
    path.join(home, 'electron', exe),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function createDesktopSupervisor({ pkgRoot, log = () => {} }) {
  let child = null
  let desired = false
  let mode = 'web'
  let snapshot = null
  let lastError = null
  let restartTimer = null
  let failures = 0
  let stopping = false
  let stdoutBuffer = ''
  let bridgePort = 0
  let pending = []
  let keyEvents = 0
  let lastKeyAt = 0
  let lastKeyAction = ''

  function state() {
    return {
      mode,
      running: Boolean(child),
      available: Boolean(electronExecutable()),
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      error: lastError,
      keyEvents,
      lastKeyAt,
      lastKeyAction,
    }
  }

  function post(route, payload) {
    if (!bridgePort) {
      if (payload !== undefined) pending.push({ route, payload })
      return true
    }
    try {
      fetch('http://127.0.0.1:' + bridgePort + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload === undefined ? '{}' : JSON.stringify(payload),
      }).catch(() => {})
      return true
    } catch {
      return false
    }
  }

  function flushPending() {
    if (!bridgePort || !pending.length) return
    const queue = pending
    pending = []
    for (const message of queue) post(message.route, message.payload)
  }

  function sendSnapshot(next) {
    snapshot = next || null
    if (snapshot) post('/config', { snapshot })
  }

  function handleLine(line) {
    if (!line.startsWith('whale:')) return
    let message
    try { message = JSON.parse(line.slice('whale:'.length)) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.type === 'port' && Number.isInteger(message.port)) {
      bridgePort = message.port
      flushPending()
    } else if (message.type === 'config' && message.snapshot) {
      snapshot = message.snapshot
      const display = snapshot.cfg && snapshot.cfg.displayMode
      if (display === 'web') {
        mode = 'web'
        stop()
      }
    } else if (message.type === 'stop') {
      if (message.snapshot && message.snapshot.cfg) snapshot = message.snapshot
      mode = 'web'
      stop()
    } else if (message.type === 'error' && typeof message.message === 'string') {
      lastError = message.message
      log('desktop helper: ' + message.message)
    }
  }

  function spawnHelper() {
    const electron = electronExecutable()
    if (!electron) {
      desired = false
      mode = 'web'
      lastError = 'Electron not found. Set DSH_WHALE_ELECTRON or install Electron in ~/.dsh/electron-whale.'
      return state()
    }
    const env = { ...process.env, DSH_WHALE_HOST_PID: String(process.pid) }
    // DSH itself runs its plugin host with this variable set. Letting it leak
    // into electron.exe starts the helper in pure Node mode and it never opens
    // a window.
    delete env.ELECTRON_RUN_AS_NODE
    lastError = null
    stopping = false
    bridgePort = 0
    stdoutBuffer = ''
    try {
      child = spawn(electron, ['--no-sandbox', path.join(pkgRoot, HELPER_MAIN)], {
        cwd: pkgRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      })
      child.unref?.()
    } catch (e) {
      child = null
      lastError = e && e.message ? e.message : String(e)
      desired = false
      mode = 'web'
      return state()
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk
      let index
      while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, index).trim()
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        if (line) handleLine(line)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      // Electron emits harmless cache/profile noise before the window exists.
      if (text.includes('[whale')) log('desktop stderr: ' + text.slice(0, 1000))
    })
    child.once('exit', (code) => {
      child = null
      bridgePort = 0
      stdoutBuffer = ''
      pending = []
      if (!desired || stopping) return
      lastError = 'desktop helper exited' + (code !== null ? ' (' + code + ')' : '')
      failures += 1
      const delay = Math.min(5000, 500 * failures)
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (desired) {
          spawnHelper()
          if (snapshot) sendSnapshot(snapshot)
        }
      }, delay)
    })
    if (snapshot) post('/config', { snapshot })
    return state()
  }

  function start(nextSnapshot) {
    snapshot = nextSnapshot || null
    desired = true
    mode = 'desktop'
    failures = 0
    lastError = null
    if (child) {
      if (snapshot) sendSnapshot(snapshot)
      return state()
    }
    return spawnHelper()
  }

  function stop() {
    desired = false
    stopping = true
    mode = 'web'
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (bridgePort) post('/stop')
    if (child) {
      const proc = child
      child = null
      bridgePort = 0
      pending = []
      setTimeout(() => {
        try { proc.kill() } catch {}
      }, 500).unref?.()
    }
    return state()
  }

  function updateConfig(next) {
    snapshot = next || null
    if (snapshot && snapshot.cfg && snapshot.cfg.displayMode === 'web') {
      return stop()
    }
    if (snapshot) sendSnapshot(snapshot)
    return state()
  }

  function noteKey(payload) {
    if (!payload) return
    keyEvents += 1
    lastKeyAt = Date.now()
    lastKeyAction = payload.action || ''
  }

  function key(payload) {
    if (!desired || !child || !payload) return false
    noteKey(payload)
    return post('/key', payload)
  }

  function keys(list) {
    if (!desired || !child || !Array.isArray(list) || !list.length) return false
    for (const item of list) noteKey(item)
    return post('/keys', { keys: list })
  }

  function dispose() {
    desired = false
    stopping = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (bridgePort) post('/stop')
    bridgePort = 0
    pending = []
    if (child) {
      try { child.kill() } catch {}
      child = null
    }
  }

  return {
    state,
    start,
    stop,
    updateConfig,
    key,
    keys,
    dispose,
    getSnapshot: () => snapshot,
  }
}
