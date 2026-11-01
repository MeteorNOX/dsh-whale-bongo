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

const { app, BrowserWindow, ipcMain, screen } = electron
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

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

if (process.platform === 'win32') {
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

function workArea() {
  return screen.getPrimaryDisplay().workArea
}

function createWindow() {
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
}

function sendConfig(snapshot) {
  pendingConfig = snapshot || null
  if (win && !win.isDestroyed()) {
    win.webContents.send('whale:config', pendingConfig)
  }
}

function stop() {
  hostGone = true
  stopGlobalKeys()
  stopDesktopWindows()
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
      latestWindows = list
      if (win && !win.isDestroyed()) win.webContents.send('whale:windows', list)
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
  startBridge()
  startGlobalKeys()
  startDesktopWindows()

  ipcMain.on('whale:ready', () => {
    if (pendingConfig) sendConfig(pendingConfig)
    if (globalKeysActive && win && !win.isDestroyed()) win.webContents.send('whale:global-keys')
    if (win && !win.isDestroyed()) win.webContents.send('whale:windows', latestWindows)
    writeLine({ type: 'ready' })
  })
  ipcMain.on('whale:interactive', (_event, interactive) => {
    if (!win || win.isDestroyed()) return
    win.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  ipcMain.on('whale:config', (_event, snapshot) => {
    pendingConfig = snapshot || null
    writeLine({ type: 'config', snapshot: pendingConfig })
  })
  ipcMain.on('whale:stop', () => {
    writeLine({ type: 'stop' })
  })

})

app.on('before-quit', () => { stopGlobalKeys(); stopDesktopWindows() })
app.on('will-quit', () => { stopGlobalKeys(); stopDesktopWindows() })
process.on('exit', () => { stopGlobalKeys(); stopDesktopWindows() })

app.on('window-all-closed', () => {
  app.quit()
})
