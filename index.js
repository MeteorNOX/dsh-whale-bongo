// dsh-whale-bongo · Host half
//
// Serves static assets and key-position data. The browser widget is mounted
// through the DSH client module lifecycle so it can be enabled/disabled live.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url))
const BASE = '/dsh-whale-bongo'
const WIDGET_PATH = BASE + '/widget.js'
const PORTRAIT_PATH = BASE + '/portrait.png'
const KEY_ANGLES_PATH = BASE + '/key-angles.json'
const VERSION = '0.2.2'

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

export default {
  name: 'dsh-whale-bongo',

  apply(root) {
    const disposers = []
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
