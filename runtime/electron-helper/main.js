/**
 * dsh-whale-bongo desktop helper.
 *
 * A deliberately small Electron main process: it owns one transparent,
 * click-through overlay window and relays a line protocol over stdio to the
 * DSH plugin host.  Window dragging and renderer config changes use IPC.
 */
let electron
try {
  electron = require('electron')
} catch (error) {
  process.stderr.write(
    '[whale helper] Electron could not be loaded. This usually means ' +
      'ELECTRON_RUN_AS_NODE leaked into the child process.\n' +
      String(error && error.message ? error.message : error) + '\n',
  )
  process.exit(3)
}

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = electron
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { windowsToOverlayDip } = require('./window-dip')

const HOST_PID = Number(process.env.DSH_WHALE_HOST_PID || 0)
const HOST_POLL_MS = 2000

let win = null
let pendingConfig = null
let latestConfig = null
let hostGone = false
let keyChild = null
let keyBuffer = ''
let globalKeysActive = false
let windowsChild = null
let windowsBuffer = ''
let latestWindows = []
let latestWindowsRaw = []
let snappedHwnd = ''
let activeDisplay = null
let activeEntryRef = null
let overlays = new Map()
let handoffPromise = null
let handoffSequence = 0
let resettingBounds = false
let tray = null
let mouseChild = null
let mouseBuffer = ''
let mouseFollowOffset = null
let mouseFollowStarted = false

if (process.env.DSH_WHALE_SOFTWARE_RENDER === '1') {
  app.disableHardwareAcceleration()
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

function hostIsGone() {
  if (!Number.isInteger(HOST_PID) || HOST_PID <= 0) return false
  try {
    process.kill(HOST_PID, 0)
    return false
  } catch (error) {
    return Boolean(error && error.code === 'ESRCH')
  }
}

function exitForDeadHost() {
  if (hostGone) return
  hostGone = true
  app.exit(0)
}

function writeLine(payload) {
  if (!process.stdout || process.stdout.destroyed) return
  try {
    process.stdout.write('whale:' + JSON.stringify(payload) + '\n')
  } catch (error) {
    if (error && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')) {
      exitForDeadHost()
    }
  }
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')) {
      exitForDeadHost()
    }
  })
}

if (Number.isInteger(HOST_PID) && HOST_PID > 0) {
  setInterval(() => {
    if (hostIsGone()) exitForDeadHost()
  }, HOST_POLL_MS).unref?.()
}

function activeEntry() {
  if (activeEntryRef && activeEntryRef.win && !activeEntryRef.win.isDestroyed()) return activeEntryRef
  return null
}

function currentDisplay() {
  if (activeDisplay) return activeDisplay
  return screen.getPrimaryDisplay()
}

function workArea() {
  return currentDisplay().workArea
}

function displayInfoFor(entry) {
  const target = entry && entry.display ? entry.display : currentDisplay()
  const info = {
    id: String(target.id),
    bounds: target.bounds,
    workArea: target.workArea,
    scaleFactor: target.scaleFactor,
  }
  if (entry && entry.win && !entry.win.isDestroyed()) {
    try {
      const cursor = screen.getCursorScreenPoint()
      const bounds = entry.win.getContentBounds()
      info.pointer = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    } catch {}
  }
  return info
}

function displayInfo(display) {
  return displayInfoFor(activeEntry() || { display: display || currentDisplay() })
}

function toOverlayDipFor(entry, list) {
  const display = entry && entry.display ? entry.display : currentDisplay()
  const area = display.workArea
  const bounds = entry && entry.win && !entry.win.isDestroyed()
    ? entry.win.getContentBounds()
    : { x: area.x, y: area.y, width: area.width, height: area.height }
  return windowsToOverlayDip(list, {
    origin: { x: bounds.x, y: bounds.y },
    width: bounds.width,
    height: bounds.height,
    scaleFactor: display.scaleFactor,
    // A candidate window may live on a display with a different DPI. Passing
    // null lets Electron pick the scale of the display containing the rect.
    toDipRect: typeof screen.screenToDipRect === 'function'
      ? (rect) => screen.screenToDipRect(null, rect)
      : null,
  })
}

function toOverlayDip(list) {
  const entry = activeEntry()
  return entry ? toOverlayDipFor(entry, list) : []
}

function sendDisplayTo(entry) {
  if (!entry || !entry.win || entry.win.isDestroyed()) return
  try { entry.win.webContents.send('whale:display', displayInfoFor(entry)) } catch {}
}

function sendDisplay() {
  sendDisplayTo(activeEntry())
}

function displayForPhysicalRect(item) {
  if (!item) return null
  const left = Number(item.left)
  const top = Number(item.top)
  const right = Number(item.right)
  const bottom = Number(item.bottom)
  if (![left, top, right, bottom].every(Number.isFinite)) return null
  if (right <= left || bottom <= top) return null
  const physical = { x: left, y: top, width: right - left, height: bottom - top }
  let dip = physical
  try {
    if (typeof screen.screenToDipRect === 'function') {
      dip = screen.screenToDipRect(null, physical) || physical
    }
  } catch {}
  const point = {
    x: Number(dip.x) + Number(dip.width) / 2,
    y: Number(dip.y) + Number(dip.height) / 2,
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  return typeof screen.getDisplayNearestPoint === 'function'
    ? screen.getDisplayNearestPoint(point)
    : screen.getDisplayMatching(physical)
}

// A-lazy: one static overlay per display, created only when needed. The
// snapped window tells us which display should be active; the target overlay
// is prepared hidden before the old one is removed.
function followSnappedWindow() {
  if (!snappedHwnd || !Array.isArray(latestWindowsRaw) || !latestWindowsRaw.length) return false
  const item = latestWindowsRaw.find((entry) => String(entry && entry.hwnd) === snappedHwnd)
  if (!item) return false
  const target = displayForPhysicalRect(item)
  if (!target) return false
  if (activeDisplay && target.id === activeDisplay.id) return false
  activateDisplay(target, { snap: true })
  return true
}

function resendWindows() {
  const entry = activeEntry()
  if (!entry) return []
  latestWindows = toOverlayDipFor(entry, latestWindowsRaw)
  try { entry.win.webContents.send('whale:windows', latestWindows) } catch {}
  return latestWindows
}

function createOverlay(display, options) {
  const target = display || screen.getPrimaryDisplay()
  const id = String(target.id)
  const existing = overlays.get(id)
  if (existing && existing.win && !existing.win.isDestroyed()) return existing
  const area = target.workArea
  const bw = new BrowserWindow({
    width: area.width,
    height: area.height,
    x: area.x,
    y: area.y,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  const entry = {
    id,
    display: target,
    win: bw,
    ready: false,
    mounted: false,
    showOnReady: Boolean(options && options.show),
    readyResolve: null,
    mountedResolve: null,
  }
  entry.readyPromise = new Promise((resolve) => { entry.readyResolve = resolve })
  entry.mountedPromise = new Promise((resolve) => { entry.mountedResolve = resolve })
  overlays.set(id, entry)

  bw.setAlwaysOnTop(true, 'screen-saver')
  bw.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  bw.setOpacity(0)
  bw.webContents.setBackgroundThrottling(false)
  try { bw.webContents.setFrameRate(60) } catch {}
  bw.setIgnoreMouseEvents(true, { forward: true })
  bw.webContents.on('did-fail-load', (_e, code, desc, url) => {
    process.stderr.write('[whale helper] did-fail-load ' + code + ' ' + desc + ' ' + url + String.fromCharCode(10))
  })
  bw.webContents.on('preload-error', (_e, preloadPath, error) => {
    process.stderr.write('[whale helper] preload-error ' + preloadPath + ' ' + String(error) + String.fromCharCode(10))
  })
  bw.webContents.on('render-process-gone', (_e, details) => {
    process.stderr.write('[whale helper] render-gone ' + JSON.stringify(details) + String.fromCharCode(10))
  })
  bw.loadFile(path.join(__dirname, 'index.html'))
  bw.once('ready-to-show', () => {
    if (entry.showOnReady) {
      entry.showOnReady = false
      bw.showInactive()
      bw.setOpacity(1)
    }
  })
  bw.webContents.once('did-finish-load', () => {
    // Fallback for an old preload that does not send whale:ready.
    setTimeout(() => {
      if (!entry.ready) {
        entry.ready = true
        entry.readyResolve?.()
      }
    }, 80)
  })
  bw.on('closed', () => {
    overlays.delete(id)
    if (activeEntryRef === entry) {
      activeEntryRef = null
      win = null
      if (!hostGone) app.quit()
    }
  })
  bw.on('blur', () => {
    try { bw.setAlwaysOnTop(true, 'screen-saver') } catch {}
    if (bw.isDestroyed()) return
    bw.webContents.send('whale:release-all')
    bw.webContents.send('whale:blur')
  })
  bw.on('moved', handleWindowMoved)
  bw.on('move', handleWindowMoved)
  return entry
}

function createWindow() {
  const entry = createOverlay(screen.getPrimaryDisplay(), { show: true })
  activeEntryRef = entry
  activeDisplay = entry.display
  win = entry.win
  return entry
}

function destroyOverlay(entry) {
  if (!entry) return
  const id = entry.id
  if (overlays.get(id) === entry) overlays.delete(id)
  try {
    if (entry.win && !entry.win.isDestroyed()) entry.win.destroy()
  } catch {}
}

function activateEntry(entry, options) {
  if (!entry || !entry.win || entry.win.isDestroyed()) return false
  const old = activeEntry()
  if (old === entry) return false
  activeEntryRef = entry
  activeDisplay = entry.display
  win = entry.win
  entry.showOnReady = false
  try {
    entry.win.setIgnoreMouseEvents(true, { forward: true })
    entry.win.setOpacity(0)
    entry.win.showInactive()
  } catch (error) {
    process.stderr.write('[whale helper] show overlay failed: ' + String(error) + String.fromCharCode(10))
    return false
  }
  // Keep the old overlay visible under the transparent target for one paint
  // turn, then reveal the target and hide the source in the same tick. This
  // avoids both a blank frame and two visible pets.
  setTimeout(() => {
    if (!entry.win || entry.win.isDestroyed()) return
    try { entry.win.setOpacity(1) } catch {}
    if (old) {
      try { old.win.hide() } catch {}
      setTimeout(() => destroyOverlay(old), 700)
    }
  }, 24)
  sendDisplayTo(entry)
  sendWindowsTo(entry)
  if (!(options && options.silent)) writeLine({ type: 'active-display', id: entry.id })
  return true
}

function sendWindowsTo(entry) {
  if (!entry || !entry.win || entry.win.isDestroyed()) return []
  const list = toOverlayDipFor(entry, latestWindowsRaw)
  if (entry === activeEntry()) latestWindows = list
  try { entry.win.webContents.send('whale:windows', list) } catch {}
  return list
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function baseSnapshot() {
  const source = pendingConfig || latestConfig
  if (!source || !source.cfg) return null
  try { return JSON.parse(JSON.stringify(source)) } catch { return null }
}

function buildSnapshot(target, options) {
  const snapshot = baseSnapshot()
  if (!snapshot) return null
  snapshot.cfg = Object.assign({}, snapshot.cfg, { displayMode: 'desktop' })
  const size = Number(snapshot.cfg.size) || 140
  const area = target.display.workArea
  if (options && options.drag) {
    const cursor = screen.getCursorScreenPoint()
    const offsetX = Number(options.offsetX) || 0
    const offsetY = Number(options.offsetY) || 0
    snapshot.cfg.snap = {
      ref: 'viewport',
      x: clamp(cursor.x - area.x - offsetX, 4, area.width - size - 4),
      y: clamp(cursor.y - area.y - offsetY, 4, area.height - size - 4),
    }
  } else if (options && options.recall) {
    const cursor = screen.getCursorScreenPoint()
    snapshot.cfg.snap = {
      ref: 'viewport',
      x: Math.round((area.width - size) / 2),
      y: Math.round((area.height - size) / 2),
    }
    snapshot.recallPoint = { x: cursor.x - area.x, y: cursor.y - area.y }
  } else if (options && options.viewport) {
    // The overlay itself was moved to another display (Shift+Win+Arrow).
    // The previously snapped window may still live on the old display, so
    // keep the widget visible at a stable position on the target display
    // instead of leaving it hidden while waiting for a missing hwnd.
    snapshot.cfg.snap = {
      ref: 'viewport',
      x: Math.round((area.width - size) / 2),
      y: Math.round((area.height - size) / 2),
    }
  } else if (snapshot.cfg.snap && snapshot.cfg.snap.ref === 'viewport') {
    snapshot.cfg.snap = {
      ref: 'viewport',
      x: clamp(Number(snapshot.cfg.snap.x) || 24, 4, area.width - size - 4),
      y: clamp(Number(snapshot.cfg.snap.y) || 24, 4, area.height - size - 4),
    }
  }
  return snapshot
}

function sendConfigTo(entry, snapshot) {
  if (!entry || !entry.win || entry.win.isDestroyed()) return
  try { entry.win.webContents.send('whale:config', snapshot) } catch {}
}

function activateDisplay(display, options) {
  const targetDisplay = display || currentDisplay()
  if (!targetDisplay) return Promise.resolve(false)
  const current = activeEntry()
  if (current && current.display.id === targetDisplay.id && !(options && options.force)) {
    if (options && options.recall) {
      try { current.win.webContents.send('whale:recall') } catch {}
    }
    return Promise.resolve(false)
  }
  if (handoffPromise) return handoffPromise
  const sequence = ++handoffSequence
  handoffPromise = (async () => {
    const existing = overlays.get(String(targetDisplay.id))
    if (existing && existing !== activeEntry()) destroyOverlay(existing)
    const target = createOverlay(targetDisplay, { show: false })
    await Promise.race([target.readyPromise, wait(1800)])
    const snapshot = buildSnapshot(target, options)
    sendConfigTo(target, snapshot)
    sendWindowsTo(target)
    sendDisplayTo(target)
    await Promise.race([target.mountedPromise, wait(1400)])
    if (sequence !== handoffSequence) return false
    if (!target.win || target.win.isDestroyed()) return false
    if (options && options.drag) {
      mouseFollowOffset = {
        x: Number(options.offsetX) || 0,
        y: Number(options.offsetY) || 0,
      }
    }
    const shown = activateEntry(target, { silent: Boolean(options && options.silent) })
    if (shown && options && options.drag) startMouseFollow()
    return shown
  })().catch((error) => {
    process.stderr.write('[whale helper] display handoff failed: ' + String(error) + String.fromCharCode(10))
    return false
  }).finally(() => {
    handoffPromise = null
  })
  return handoffPromise
}

function handleWindowMoved() {
  if (resettingBounds || handoffPromise) return
  const entry = activeEntry()
  if (!entry) return
  const bounds = entry.win.getContentBounds()
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const target = typeof screen.getDisplayNearestPoint === 'function'
    ? screen.getDisplayNearestPoint(center)
    : screen.getDisplayMatching(bounds)
  if (target.id !== entry.display.id) {
    // Shift+Win+Arrow moved the whole overlay. Restore its static display and
    // hand off to the target display's own overlay instead of resizing it.
    resettingBounds = true
    try { entry.win.setContentBounds(entry.display.workArea) } catch {}
    resettingBounds = false
    activateDisplay(target, { silent: true, viewport: true })
    return
  }
  const area = entry.display.workArea
  if (Math.abs(bounds.x - area.x) > 3 || Math.abs(bounds.y - area.y) > 3 ||
      Math.abs(bounds.width - area.width) > 3 || Math.abs(bounds.height - area.height) > 3) {
    resettingBounds = true
    try { entry.win.setContentBounds(area) } catch {}
    resettingBounds = false
  }
}

function requestDisplay(payload) {
  const entry = activeEntry()
  if (!entry) return
  const bounds = entry.win.getContentBounds()
  const x = payload && Number.isFinite(Number(payload.x)) ? Number(payload.x) : 0
  const y = payload && Number.isFinite(Number(payload.y)) ? Number(payload.y) : 0
  const edge = payload && payload.edge
  const step = 8
  const point = { x: bounds.x + x, y: bounds.y + y }
  if (edge === 'left') point.x -= step
  else if (edge === 'right') point.x += step
  else if (edge === 'top') point.y -= step
  else if (edge === 'bottom') point.y += step
  else return
  const target = typeof screen.getDisplayNearestPoint === 'function'
    ? screen.getDisplayNearestPoint(point)
    : screen.getDisplayMatching(bounds)
  if (!target || target.id === entry.display.id) return
  activateDisplay(target, {
    drag: true,
    offsetX: payload && payload.offsetX,
    offsetY: payload && payload.offsetY,
  })
}

function recallWidget() {
  const entry = activeEntry()
  if (!entry) return
  const point = screen.getCursorScreenPoint()
  const target = typeof screen.getDisplayNearestPoint === 'function'
    ? screen.getDisplayNearestPoint(point)
    : screen.getDisplayMatching(entry.win.getContentBounds())
  if (target.id === entry.display.id) {
    try { entry.win.webContents.send('whale:recall') } catch {}
    return
  }
  activateDisplay(target, { recall: true })
}

function createTray() {
  if (tray) return
  try {
    let image = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'dsh-whale-bongo-icon.png'))
    if (image.isEmpty()) return
    image = image.resize({ width: 16, height: 16 })
    tray = new Tray(image)
    tray.setToolTip('DSH 桌宠')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '召回挂件到当前屏幕', click: recallWidget },
    ]))
    tray.on('click', recallWidget)
  } catch (error) {
    tray = null
    process.stderr.write('[whale helper] tray failed: ' + String(error) + String.fromCharCode(10))
  }
}

function destroyTray() {
  if (!tray) return
  try { tray.destroy() } catch {}
  tray = null
}

function sendConfig(snapshot) {
  pendingConfig = snapshot || null
  if (pendingConfig) latestConfig = pendingConfig
  sendConfigTo(activeEntry(), pendingConfig)
  if (pendingConfig && pendingConfig.followMouse && activeEntry()) {
    mouseFollowOffset = null
    startMouseFollow()
  }
}

function stop() {
  hostGone = true
  stopGlobalKeys()
  stopDesktopWindows()
  stopMouseFollow()
  destroyTray()
  try { if (bridgeServer) bridgeServer.close() } catch {}
  win = null
  activeEntryRef = null
  activeDisplay = null
  for (const entry of Array.from(overlays.values())) destroyOverlay(entry)
  app.quit()
}

let bridgeServer = null
let bridgePort = 0

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 32 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function startBridge() {
  bridgeServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && req.url === '/config') {
      readBody(req).then((body) => {
        sendConfig(body && body.snapshot ? body.snapshot : null)
        sendJson(res, 200, { ok: true })
      }).catch((error) => sendJson(res, 400, { ok: false, error: String(error) }))
      return
    }
    if (req.method === 'POST' && req.url === '/input-anchor') {
      readBody(req).then((body) => {
        if (win && !win.isDestroyed()) win.webContents.send('whale:input-anchor', body || null)
        sendJson(res, 200, { ok: true })
      }).catch((error) => sendJson(res, 400, { ok: false, error: String(error) }))
      return
    }
    if (req.method === 'POST' && req.url === '/key') {
      readBody(req).then((body) => {
        if (win && !win.isDestroyed()) win.webContents.send('whale:key', body || null)
        sendJson(res, 200, { ok: true })
      }).catch((error) => sendJson(res, 400, { ok: false, error: String(error) }))
      return
    }

    if (req.method === 'POST' && req.url === '/keys') {
      readBody(req).then((body) => {
        const list = body && Array.isArray(body.keys) ? body.keys : []
        if (win && !win.isDestroyed()) {
          for (const key of list) win.webContents.send('whale:key', key || null)
        }
        sendJson(res, 200, { ok: true })
      }).catch((error) => sendJson(res, 400, { ok: false, error: String(error) }))
      return
    }
    if (req.method === 'POST' && req.url === '/stop') {
      sendJson(res, 200, { ok: true })
      setTimeout(stop, 20)
      return
    }
    sendJson(res, 404, { ok: false })
  })
  bridgeServer.listen(0, '127.0.0.1', () => {
    bridgePort = bridgeServer.address().port
    writeLine({ type: 'port', port: bridgePort })
    if (pendingConfig) sendConfig(pendingConfig)
  })
  bridgeServer.on('error', (error) => {
    process.stderr.write('[whale helper] bridge error ' + String(error) + String.fromCharCode(10))
  })
}

const VK_CODE_MAP = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Escape', 32: 'Space',
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
  37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
  45: 'Insert', 46: 'Delete',
  186: 'Semicolon', 187: 'Equal', 188: 'Comma', 189: 'Minus',
  190: 'Period', 191: 'Slash', 192: 'Backquote',
  219: 'BracketLeft', 220: 'Backslash', 221: 'BracketRight', 222: 'Quote',
  0x60: 'Numpad0', 0x61: 'Numpad1', 0x62: 'Numpad2', 0x63: 'Numpad3',
  0x64: 'Numpad4', 0x65: 'Numpad5', 0x66: 'Numpad6', 0x67: 'Numpad7',
  0x68: 'Numpad8', 0x69: 'Numpad9', 0x6A: 'NumpadMultiply',
  0x6B: 'NumpadAdd', 0x6C: 'NumpadComma', 0x6D: 'NumpadSubtract',
  0x6E: 'NumpadDecimal', 0x6F: 'NumpadDivide', 0x92: 'NumpadEqual',
}
for (let i = 0; i < 26; i++) VK_CODE_MAP[0x41 + i] = 'Key' + String.fromCharCode(0x41 + i)
for (let i = 0; i < 10; i++) VK_CODE_MAP[0x30 + i] = 'Digit' + i
for (let i = 1; i <= 12; i++) VK_CODE_MAP[0x6F + i] = 'F' + i

function vkCode(vk) {
  return VK_CODE_MAP[vk] || ('VK_' + vk)
}

function handleGlobalKeyLine(line) {
  const parts = line.trim().split('|')
  if (parts.length !== 6) return
  const down = parts[0] === '1'
  const vk = Number(parts[1])
  if (!Number.isInteger(vk)) return
  // Mouse buttons, modifiers and lock keys are not typing input.
  if (vk < 8 || vk === 16 || vk === 17 || vk === 18 || vk === 20 ||
      vk === 91 || vk === 92 || vk === 144 || vk === 145) return
  const code = vkCode(vk)
  const payload = {
    action: down ? 'down' : 'up',
    key: code,
    code: code,
    ctrlKey: parts[2] === '1',
    altKey: parts[3] === '1',
    shiftKey: parts[4] === '1',
    metaKey: parts[5] === '1',
  }
  if (win && !win.isDestroyed()) win.webContents.send('whale:key', payload)
}

function startMouseFollow() {
  if (process.platform !== 'win32' || mouseChild || mouseFollowStarted) return
  mouseFollowStarted = true
  try {
    mouseChild = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'mouse-follow.ps1'),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    mouseChild = null
    process.stderr.write('[whale helper] mouse follow failed: ' + String(error) + String.fromCharCode(10))
    return
  }
  mouseChild.stdout.setEncoding('utf8')
  mouseChild.stdout.on('data', (chunk) => {
    mouseBuffer += chunk
    let index
    while ((index = mouseBuffer.indexOf(String.fromCharCode(10))) !== -1) {
      const line = mouseBuffer.slice(0, index).trim()
      mouseBuffer = mouseBuffer.slice(index + 1)
      const parts = line.split('|')
      if (parts.length !== 3) continue
      const left = parts[0] === '1'
      const screenX = Number(parts[1])
      const screenY = Number(parts[2])
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) continue
      const bounds = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0 }
      if (win && !win.isDestroyed()) {
        const follow = {
          left: left,
          x: screenX - bounds.x,
          y: screenY - bounds.y,
        }
        if (mouseFollowOffset) {
          follow.offsetX = mouseFollowOffset.x
          follow.offsetY = mouseFollowOffset.y
        }
        win.webContents.send('whale:mouse-follow', follow)
      }
      if (!left) {
        mouseFollowOffset = null
        stopMouseFollow()
      }
    }
  })
  mouseChild.stderr.setEncoding('utf8')
  mouseChild.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) process.stderr.write('[whale helper] mouse error: ' + text.slice(0, 500) + String.fromCharCode(10))
  })
  mouseChild.once('exit', () => {
    mouseChild = null
    mouseBuffer = ''
  })
  if (win && !win.isDestroyed()) {
    try {
      const point = screen.getCursorScreenPoint()
      const bounds = win.getBounds()
      const follow = {
        left: true,
        x: point.x - bounds.x,
        y: point.y - bounds.y,
      }
      if (mouseFollowOffset) {
        follow.offsetX = mouseFollowOffset.x
        follow.offsetY = mouseFollowOffset.y
      }
      win.webContents.send('whale:mouse-follow', follow)
    } catch {}
  }
}

function stopMouseFollow() {
  mouseFollowStarted = false
  if (!mouseChild) return
  try { mouseChild.kill() } catch {}
  mouseChild = null
  mouseBuffer = ''
}

function startDesktopWindows() {
  if (process.platform !== 'win32' || windowsChild) return
  try {
    windowsChild = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'desktop-windows.ps1'),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_WHALE_HELPER_PID: String(process.pid) },
    })
  } catch (error) {
    windowsChild = null
    process.stderr.write('[whale helper] windows watcher failed: ' + String(error) + String.fromCharCode(10))
    return
  }
  windowsChild.stdout.setEncoding('utf8')
  windowsChild.stdout.on('data', (chunk) => {
    windowsBuffer += chunk
    let index
    while ((index = windowsBuffer.indexOf(String.fromCharCode(10))) !== -1) {
      const line = windowsBuffer.slice(0, index).trim()
      windowsBuffer = windowsBuffer.slice(index + 1)
      if (!line) continue
      let list
      try { list = JSON.parse(line) } catch { continue }
      if (!Array.isArray(list)) continue
      latestWindowsRaw = list
      if (handoffPromise) continue
      // Switch displays before publishing a list that no longer contains the
      // snapped hwnd. The new overlay receives the unfiltered raw list.
      if (followSnappedWindow()) continue
      const entry = activeEntry()
      if (!entry) continue
      latestWindows = toOverlayDipFor(entry, latestWindowsRaw)
      try { entry.win.webContents.send('whale:windows', latestWindows) } catch {}
    }
  })
  windowsChild.stderr.setEncoding('utf8')
  windowsChild.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) process.stderr.write('[whale helper] windows error: ' + text.slice(0, 500) + String.fromCharCode(10))
  })
  windowsChild.once('exit', () => {
    windowsChild = null
  })
}

function stopDesktopWindows() {
  if (!windowsChild) return
  try { windowsChild.kill() } catch {}
  windowsChild = null
  windowsBuffer = ''
}

function startGlobalKeys() {
  if (process.platform !== 'win32' || keyChild) return
  try {
    keyChild = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'global-keys.ps1'),
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    keyChild = null
    process.stderr.write('[whale helper] global key hook failed: ' + String(error) + String.fromCharCode(10))
    return
  }
  globalKeysActive = true
  if (win && !win.isDestroyed()) win.webContents.send('whale:global-keys')
  keyChild.stdout.setEncoding('utf8')
  keyChild.stdout.on('data', (chunk) => {
    keyBuffer += chunk
    let index
    while ((index = keyBuffer.indexOf(String.fromCharCode(10))) !== -1) {
      const line = keyBuffer.slice(0, index).trim()
      keyBuffer = keyBuffer.slice(index + 1)
      if (line) handleGlobalKeyLine(line)
    }
  })
  keyChild.stderr.setEncoding('utf8')
  keyChild.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) process.stderr.write('[whale helper] global key error: ' + text.slice(0, 500) + String.fromCharCode(10))
  })
  keyChild.once('exit', () => {
    keyChild = null
    globalKeysActive = false
  })
}

function stopGlobalKeys() {
  if (!keyChild) return
  try { keyChild.kill() } catch {}
  keyChild = null
  keyBuffer = ''
}

function entryForEvent(event) {
  for (const entry of overlays.values()) {
    if (entry.win && !entry.win.isDestroyed() && entry.win.webContents === event.sender) return entry
  }
  return null
}

function handleDisplayChange() {
  const displays = screen.getAllDisplays()
  const ids = new Set(displays.map((display) => String(display.id)))
  for (const [id, entry] of overlays) {
    if (!ids.has(id) && entry !== activeEntry()) destroyOverlay(entry)
  }
  const entry = activeEntry()
  if (!entry) return
  const kept = displays.find((display) => String(display.id) === entry.id)
  if (kept) {
    entry.display = kept
    resettingBounds = true
    try { entry.win.setContentBounds(kept.workArea) } catch {}
    resettingBounds = false
    activeDisplay = kept
    sendDisplayTo(entry)
    sendWindowsTo(entry)
    return
  }
  const target = typeof screen.getDisplayNearestPoint === 'function'
    ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    : screen.getPrimaryDisplay()
  activateDisplay(target, { silent: true })
}

app.whenReady().then(() => {
  createWindow()
  createTray()
  startBridge()
  startGlobalKeys()
  startDesktopWindows()

  screen.on('display-removed', handleDisplayChange)
  screen.on('display-metrics-changed', handleDisplayChange)
  screen.on('display-added', handleDisplayChange)

  ipcMain.on('whale:ready', (event) => {
    const entry = entryForEvent(event)
    if (!entry) return
    entry.ready = true
    try { entry.readyResolve?.() } catch {}
    if (entry === activeEntry()) {
      if (pendingConfig) sendConfigTo(entry, pendingConfig)
      if (globalKeysActive && entry.win && !entry.win.isDestroyed()) {
        entry.win.webContents.send('whale:global-keys')
      }
      sendWindowsTo(entry)
      sendDisplayTo(entry)
      writeLine({ type: 'ready' })
    }
  })
  ipcMain.on('whale:renderer-mounted', (event) => {
    const entry = entryForEvent(event)
    if (!entry) return
    entry.mounted = true
    try { entry.mountedResolve?.() } catch {}
  })
  ipcMain.on('whale:interactive', (event, interactive) => {
    const entry = entryForEvent(event)
    if (!entry || !entry.win || entry.win.isDestroyed()) return
    entry.win.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  ipcMain.on('whale:request-display', (event, payload) => {
    if (entryForEvent(event) !== activeEntry()) return
    requestDisplay(payload)
  })
  ipcMain.on('whale:snap-window', (_event, payload) => {
    const hwnd = payload && payload.hwnd ? String(payload.hwnd) : ''
    snappedHwnd = hwnd
    if (hwnd) followSnappedWindow()
  })
  ipcMain.on('whale:config', (event, snapshot) => {
    const entry = entryForEvent(event)
    if (!entry || entry !== activeEntry()) return
    pendingConfig = snapshot || null
    latestConfig = pendingConfig
    writeLine({ type: 'config', snapshot: pendingConfig })
  })
  ipcMain.on('whale:request-anchor', (event) => {
    if (entryForEvent(event) !== activeEntry()) return
    writeLine({ type: 'request-anchor' })
  })
  ipcMain.on('whale:stop', (event, snapshot) => {
    if (entryForEvent(event) !== activeEntry()) return
    if (snapshot && snapshot.cfg) pendingConfig = snapshot
    latestConfig = pendingConfig
    writeLine({ type: 'stop', snapshot: pendingConfig })
  })

})

app.on('before-quit', () => { stopGlobalKeys(); stopDesktopWindows(); stopMouseFollow(); destroyTray() })
app.on('will-quit', () => { stopGlobalKeys(); stopDesktopWindows(); stopMouseFollow(); destroyTray() })
process.on('exit', () => { stopGlobalKeys(); stopDesktopWindows(); stopMouseFollow(); destroyTray() })

app.on('window-all-closed', () => {
  app.quit()
})
