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
let rehoming = false
let rehomeTimer = null
let rehomeNotifyTimer = null
let displaySwitchPending = false
let displayFadeTimer = null
let tray = null
let mouseChild = null
let mouseBuffer = ''
let rendererReady = false
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

function currentDisplay() {
  if (activeDisplay) return activeDisplay
  if (win && !win.isDestroyed()) {
    const bounds = win.getContentBounds()
    if (typeof screen.getDisplayMatching === 'function') {
      return screen.getDisplayMatching(bounds)
    }
  }
  return screen.getPrimaryDisplay()
}

function workArea() {
  return currentDisplay().workArea
}

function displayInfo(display) {
  const target = display || currentDisplay()
  const info = {
    id: String(target.id),
    bounds: target.bounds,
    workArea: target.workArea,
    scaleFactor: target.scaleFactor,
  }
  if (win && !win.isDestroyed()) {
    try {
      const cursor = screen.getCursorScreenPoint()
      const bounds = win.getContentBounds()
      info.pointer = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    } catch {}
  }
  return info
}

function toOverlayDip(list) {
  const area = workArea()
  const bounds = win && !win.isDestroyed()
    ? win.getContentBounds()
    : { x: area.x, y: area.y, width: area.width, height: area.height }
  const display = currentDisplay()
  return windowsToOverlayDip(list, {
    origin: { x: bounds.x, y: bounds.y },
    width: bounds.width,
    height: bounds.height,
    scaleFactor: display.scaleFactor,
    // screenToDipRect converts a physical screen rectangle using the DPI of
    // the display the rectangle belongs to. Passing null here is deliberate:
    // the overlay itself is only on the active display, but the candidate
    // windows may span mixed-DPI monitors.
    toDipRect: typeof screen.screenToDipRect === 'function'
      ? (rect) => screen.screenToDipRect(null, rect)
      : null,
  })
}

function sendDisplay() {
  if (!win || win.isDestroyed()) return
  try { win.webContents.send('whale:display', displayInfo()) } catch {}
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

// The overlay can only draw one display at a time. When the window the pet is
// attached to crosses a monitor boundary, move the whole overlay first so the
// renderer keeps receiving that hwnd instead of falling back to a viewport snap.
function followSnappedWindow() {
  if (!snappedHwnd || !Array.isArray(latestWindowsRaw) || !latestWindowsRaw.length) return false
  const item = latestWindowsRaw.find((entry) => String(entry && entry.hwnd) === snappedHwnd)
  if (!item) return false
  const target = displayForPhysicalRect(item)
  if (!target) return false
  if (activeDisplay && target.id === activeDisplay.id) return false
  return rehomeTo(target)
}

function resendWindows() {
  latestWindows = toOverlayDip(latestWindowsRaw)
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('whale:windows', latestWindows) } catch {}
  }
  return latestWindows
}

function createWindow() {
  activeDisplay = screen.getPrimaryDisplay()
  const area = workArea()
  win = new BrowserWindow({
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
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.setBackgroundThrottling(false)
  try { win.webContents.setFrameRate(60) } catch {}
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    process.stderr.write('[whale helper] did-fail-load ' + code + ' ' + desc + ' ' + url + String.fromCharCode(10))
  })
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    process.stderr.write('[whale helper] preload-error ' + preloadPath + ' ' + String(error) + String.fromCharCode(10))
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    process.stderr.write('[whale helper] render-gone ' + JSON.stringify(details) + String.fromCharCode(10))
  })
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => {
    win.show()
  })
  win.webContents.once('did-finish-load', () => {
    win.show()
  })
  win.on('closed', () => {
    win = null
    app.quit()
  })
  win.on('blur', () => {
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch {}
    if (!win || win.isDestroyed()) return
    win.webContents.send('whale:release-all')
    win.webContents.send('whale:blur')
  })
  win.on('moved', handleWindowMoved)
  // Windows may report an OS-initiated move (Shift+Win+Arrow) through 'move'
  // without a matching 'moved'. Debouncing keeps the rehome check cheap.
  win.on('move', handleWindowMoved)
}

function rehomeTo(display, options) {
  if (!win || win.isDestroyed()) return false
  const target = display || currentDisplay()
  if (!target) return false
  const area = target.workArea
  const same = activeDisplay && activeDisplay.id === target.id
  const force = Boolean(options && options.force)
  const recall = Boolean(options && options.recall)
  if (same && !force && !recall) return false
  if (displaySwitchPending) return true
  const switching = !same
  const commit = () => {
    activeDisplay = target
    rehoming = true
    try {
      // setContentBounds keeps the transparent canvas exactly on the work area
      // instead of inheriting the frame/shadow size of the previous display.
      if (!same || force) {
        win.setContentBounds({
          x: area.x,
          y: area.y,
          width: area.width,
          height: area.height,
        })
      }
    } catch (error) {
      process.stderr.write('[whale helper] rehome failed: ' + String(error) + String.fromCharCode(10))
    } finally {
      rehoming = false
    }
    if (rehomeNotifyTimer) {
      try { clearTimeout(rehomeNotifyTimer) } catch {}
    }
    // Let Chromium deliver the resize before the renderer rebases pointer
    // coordinates. Sending synchronously would use the old innerWidth.
    rehomeNotifyTimer = setTimeout(() => {
      rehomeNotifyTimer = null
      if (!win || win.isDestroyed()) return
      resendWindows()
      sendDisplay()
      if (displaySwitchPending) {
        displaySwitchPending = false
        try {
          win.webContents.send('whale:display-switch', {
            phase: 'in',
            id: String(activeDisplay.id),
          })
        } catch {}
      }
      if (options && options.recall) {
        try { win.webContents.send('whale:recall') } catch {}
      }
    }, 80)
  }
  if (switching && win && !win.isDestroyed()) {
    displaySwitchPending = true
    try {
      win.webContents.send('whale:display-switch', {
        phase: 'out',
        from: activeDisplay ? String(activeDisplay.id) : '',
        to: String(target.id),
      })
    } catch {}
    // Give the 65ms opacity fade time to finish before resizing the native
    // window. Otherwise the resize is visible halfway through the fade.
    if (displayFadeTimer) {
      try { clearTimeout(displayFadeTimer) } catch {}
    }
    displayFadeTimer = setTimeout(() => {
      displayFadeTimer = null
      if (!win || win.isDestroyed()) {
        displaySwitchPending = false
        return
      }
      commit()
    }, 72)
    return true
  }
  commit()
  return true
}

function handleWindowMoved() {
  if (rehoming) return
  if (rehomeTimer) {
    try { clearTimeout(rehomeTimer) } catch {}
  }
  rehomeTimer = setTimeout(() => {
    rehomeTimer = null
    if (!win || win.isDestroyed()) return
    const bounds = win.getContentBounds()
    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    }
    const target = typeof screen.getDisplayNearestPoint === 'function'
      ? screen.getDisplayNearestPoint(center)
      : screen.getDisplayMatching(bounds)
    if (!activeDisplay || target.id !== activeDisplay.id) {
      rehomeTo(target)
      return
    }
    // The OS can move a frameless always-on-top window (for example
    // Shift+Win+Arrow). Keep the overlay covering the work area instead of
    // leaving a primary-sized window stranded on another monitor.
    const area = activeDisplay.workArea
    if (Math.abs(bounds.x - area.x) > 3 || Math.abs(bounds.y - area.y) > 3) {
      rehomeTo(activeDisplay, { force: true })
    }
  }, 90)
}

function requestDisplay(payload) {
  if (!win || win.isDestroyed()) return
  const bounds = win.getContentBounds()
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
  if (!target || (activeDisplay && target.id === activeDisplay.id)) return
  rehomeTo(target)
}

function recallWidget() {
  if (!win || win.isDestroyed()) return
  const point = screen.getCursorScreenPoint()
  const target = typeof screen.getDisplayNearestPoint === 'function'
    ? screen.getDisplayNearestPoint(point)
    : screen.getDisplayMatching(win.getContentBounds())
  rehomeTo(target, { recall: true })
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
  if (win && !win.isDestroyed()) {
    win.webContents.send('whale:config', pendingConfig)
  }
  if (pendingConfig && pendingConfig.followMouse && rendererReady) startMouseFollow()
}

function stop() {
  hostGone = true
  stopGlobalKeys()
  stopDesktopWindows()
  stopMouseFollow()
  destroyTray()
  try { if (bridgeServer) bridgeServer.close() } catch {}
  try { if (win && !win.isDestroyed()) win.destroy() } catch {}
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
        win.webContents.send('whale:mouse-follow', {
          left: left,
          x: screenX - bounds.x,
          y: screenY - bounds.y,
        })
      }
      if (!left) stopMouseFollow()
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
}

function stopMouseFollow() {
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
      // Rehome before publishing a list that no longer contains the snapped
      // hwnd. Otherwise the renderer would immediately replace the attachment
      // with a viewport snap at the old screen edge.
      if (followSnappedWindow()) continue
      if (rehomeNotifyTimer) continue
      latestWindows = toOverlayDip(latestWindowsRaw)
      if (win && !win.isDestroyed()) win.webContents.send('whale:windows', latestWindows)
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

app.whenReady().then(() => {
  createWindow()
  createTray()
  startBridge()
  startGlobalKeys()
  startDesktopWindows()

  const rehomeForDisplays = () => {
    if (!activeDisplay) return
    const displays = screen.getAllDisplays()
    const kept = displays.find((display) => display.id === activeDisplay.id)
    if (kept) {
      rehomeTo(kept, { force: true })
    } else {
      const target = typeof screen.getDisplayNearestPoint === 'function'
        ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        : screen.getPrimaryDisplay()
      rehomeTo(target)
    }
  }
  screen.on('display-removed', rehomeForDisplays)
  screen.on('display-metrics-changed', rehomeForDisplays)
  screen.on('display-added', rehomeForDisplays)

  ipcMain.on('whale:ready', () => {
    rendererReady = true
    if (pendingConfig) sendConfig(pendingConfig)
    if (pendingConfig && pendingConfig.followMouse) startMouseFollow()
    if (globalKeysActive && win && !win.isDestroyed()) win.webContents.send('whale:global-keys')
    if (win && !win.isDestroyed()) {
      win.webContents.send('whale:windows', latestWindows)
      sendDisplay()
    }
    writeLine({ type: 'ready' })
  })
  ipcMain.on('whale:interactive', (_event, interactive) => {
    if (!win || win.isDestroyed()) return
    win.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  ipcMain.on('whale:request-display', (_event, payload) => {
    requestDisplay(payload)
  })
  ipcMain.on('whale:snap-window', (_event, payload) => {
    const hwnd = payload && payload.hwnd ? String(payload.hwnd) : ''
    snappedHwnd = hwnd
    if (hwnd) followSnappedWindow()
  })
  ipcMain.on('whale:config', (_event, snapshot) => {
    pendingConfig = snapshot || null
    writeLine({ type: 'config', snapshot: pendingConfig })
  })
  ipcMain.on('whale:request-anchor', () => {
    writeLine({ type: 'request-anchor' })
  })
  ipcMain.on('whale:stop', (_event, snapshot) => {
    if (snapshot && snapshot.cfg) pendingConfig = snapshot
    writeLine({ type: 'stop', snapshot: pendingConfig })
  })

})

app.on('before-quit', () => { stopGlobalKeys(); stopDesktopWindows(); stopMouseFollow(); destroyTray() })
app.on('will-quit', () => { stopGlobalKeys(); stopDesktopWindows(); stopMouseFollow(); destroyTray() })
process.on('exit', () => { stopGlobalKeys(); stopDesktopWindows(); stopMouseFollow(); destroyTray() })

app.on('window-all-closed', () => {
  app.quit()
})
