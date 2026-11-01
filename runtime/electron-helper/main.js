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

const WIDTH = 620
const HEIGHT = 780
const HOST_PID = Number(process.env.DSH_WHALE_HOST_PID || 0)
const HOST_POLL_MS = 2000

let win = null
let pendingConfig = null
let hostGone = false
let drag = null

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

function windowPosition() {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: Math.max(area.x, area.x + area.width - WIDTH - 24),
    y: Math.max(area.y, area.y + area.height - HEIGHT - 24),
  }
}

function createWindow() {
  const position = windowPosition()
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: position.x,
    y: position.y,
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
    // A frameless window has no OS title bar; keep it topmost.
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch {}
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

app.whenReady().then(() => {
  createWindow()
  startBridge()

  ipcMain.on('whale:ready', () => {
    if (pendingConfig) sendConfig(pendingConfig)
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

  ipcMain.on('whale:drag-start', (_event, point) => {
    if (!win || win.isDestroyed() || !point) return
    const bounds = win.getBounds()
    drag = {
      x: Number(point.x) || 0,
      y: Number(point.y) || 0,
      bx: bounds.x,
      by: bounds.y,
    }
  })
  ipcMain.on('whale:drag-move', (_event, point) => {
    if (!win || win.isDestroyed() || !drag || !point) return
    const x = drag.bx + (Number(point.x) - drag.x)
    const y = drag.by + (Number(point.y) - drag.y)
    win.setPosition(Math.round(x), Math.round(y))
  })
  ipcMain.on('whale:drag-end', () => {
    drag = null
  })
})

app.on('before-quit', () => {
  drag = null
})

app.on('window-all-closed', () => {
  app.quit()
})
