// dsh-whale-bongo · Host half
//
// Serves static assets and key-position data. The browser widget is mounted
// through the DSH client module lifecycle so it can be enabled/disabled live.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDesktopSupervisor } from './desktop.js'

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url))
const BASE = '/dsh-whale-bongo'
const WIDGET_PATH = BASE + '/widget.js'
const PORTRAIT_PATH = BASE + '/portrait.png'
const KEY_ANGLES_PATH = BASE + '/key-angles.json'
const VERSION = '0.3.0'

const diag = {
  startedAt: Date.now(),
  widgetRequests: 0,
  portraitRequests: 0,
  lastWidgetAt: null,
}

let widgetCache = null
function loadWidgetJs() {
  const file = path.join(PKG_ROOT, 'assets', 'widget.js')
  try {
    const stat = fs.statSync(file)
    if (widgetCache && widgetCache.mtimeMs === stat.mtimeMs) return widgetCache.text
    const text = fs.readFileSync(file, 'utf8')
    widgetCache = { text, mtimeMs: stat.mtimeMs }
    return text
  } catch {
    return widgetCache ? widgetCache.text : ''
  }
}

let portrait = null
try {
  portrait = fs.readFileSync(path.join(PKG_ROOT, 'assets', 'portrait.png'))
} catch {
  portrait = null
}

let keyAngles = null
try {
  keyAngles = fs.readFileSync(path.join(PKG_ROOT, 'assets', 'key-angles.json'))
} catch {
  keyAngles = null
}

function json(res, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  })
  res.end(body)
}

function readJsonBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
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

function text(res, status, body) {
  const value = Buffer.from(String(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(value.length),
  })
  res.end(value)
}

export default {
  name: 'dsh-whale-bongo',

  apply(root) {
    const disposers = []
    const desktop = createDesktopSupervisor({
      pkgRoot: PKG_ROOT,
      log: (message) => console.warn('[dsh-whale-bongo] ' + message),
    })
    root.effect(() => () => desktop.dispose())
    root.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch {}
      }
      disposers.length = 0
    })

    root.inject(['webServer'], (ctx) => {
      const route = (options) => {
        const off = ctx.webServer.register(options)
        if (typeof off === 'function') disposers.push(off)
      }

      route({
        kind: 'exact',
        path: WIDGET_PATH,
        handler(req, res) {
          diag.widgetRequests += 1
          diag.lastWidgetAt = Date.now()
          const body = loadWidgetJs()
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(Buffer.byteLength(body)),
          })
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      })

      route({
        kind: 'exact',
        path: PORTRAIT_PATH,
        handler(req, res) {
          diag.portraitRequests += 1
          if (!portrait) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('portrait not found')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'Content-Length': String(portrait.length),
          })
          res.end(req.method === 'HEAD' ? undefined : portrait)
        },
      })

      route({
        kind: 'exact',
        path: KEY_ANGLES_PATH,
        handler(req, res) {
          if (!keyAngles) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('key angles not found')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(keyAngles.length),
          })
          res.end(req.method === 'HEAD' ? undefined : keyAngles)
        },
      })

      route({
        kind: 'exact',
        path: BASE + '/desktop/status',
        handler(req, res) {
          json(res, { ok: true, ...desktop.state() })
        },
      })

      route({
        kind: 'exact',
        path: BASE + '/desktop/start',
        handler(req, res) {
          readJsonBody(req).then((body) => {
            json(res, { ok: true, ...desktop.start(body && body.cfg ? body : null) })
          }).catch((error) => text(res, 400, error && error.message ? error.message : String(error)))
        },
      })

      route({
        kind: 'exact',
        path: BASE + '/desktop/stop',
        handler(req, res) {
          desktop.stop()
          json(res, { ok: true, ...desktop.state() })
        },
      })

      route({
        kind: 'exact',
        path: BASE + '/desktop/config',
        handler(req, res) {
          if (req.method === 'GET') {
            json(res, { ok: true, snapshot: desktop.getSnapshot() })
            return
          }
          readJsonBody(req).then((body) => {
            json(res, { ok: true, ...desktop.updateConfig(body && body.cfg ? body : null) })
          }).catch((error) => text(res, 400, error && error.message ? error.message : String(error)))
        },
      })

      route({
        kind: 'exact',
        path: BASE + '/desktop/keys',
        handler(req, res) {
          readJsonBody(req, 256 * 1024).then((body) => {
            const list = body && Array.isArray(body.keys) ? body.keys : []
            json(res, { ok: desktop.keys(list) })
          }).catch((error) => text(res, 400, error && error.message ? error.message : String(error)))
        },
      })

      route({
        kind: 'exact',
        path: BASE + '/desktop/key',
        handler(req, res) {
          readJsonBody(req, 64 * 1024).then((body) => {
            const accepted = desktop.key(body)
            json(res, { ok: accepted })
          }).catch((error) => text(res, 400, error && error.message ? error.message : String(error)))
        },
      })

      route({
        kind: 'exact',
        path: BASE + '/health',
        handler(req, res) {
          json(res, {
            ok: true,
            version: VERSION,
            widget: WIDGET_PATH,
            portrait: PORTRAIT_PATH,
            portraitBytes: portrait ? portrait.length : 0,
            keyAngles: KEY_ANGLES_PATH,
            keyAnglesBytes: keyAngles ? keyAngles.length : 0,
            widgetBytes: Buffer.byteLength(loadWidgetJs()),
            desktop: desktop.state(),
            diag,
          })
        },
      })

      route({
        kind: 'exact',
        path: BASE + '/diag',
        handler(req, res) {
          json(res, { ok: true, version: VERSION, diag })
        },
      })

    })
  },
}
