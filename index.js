// dsh-whale-bongo · Host half
//
// Injects the browser widget and serves its default portrait / widget script.
// Both injection paths are kept, matching dsh-bongo-fish:
//   · Web:      webServer.tapIndex inserts <script defer src=...>
//   · Desktop:  webserver/index-inject inserts a structured script row
// The tiny client loader is a second bootstrap path so an already-running
// desktop app can pick up the widget after a page refresh.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url))
const BASE = '/dsh-whale-bongo'
const WIDGET_PATH = BASE + '/widget.js'
const PORTRAIT_PATH = BASE + '/portrait.png'
const KEY_ANGLES_PATH = BASE + '/key-angles.json'
const VERSION = '0.2.0'

const diag = {
  startedAt: Date.now(),
  indexEvents: 0,
  indexRows: 0,
  indexDuplicates: 0,
  tapEvents: 0,
  tapPages: 0,
  widgetRequests: 0,
  portraitRequests: 0,
  lastWidgetAt: null,
  lastPageAt: null,
  lastRowAt: null,
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

const DESKTOP_ROW_TEXT =
  '(function(){try{try{localStorage.setItem("dsh-whale-bongo:desktop-inject",String(Date.now()))}catch(e){}' +
  'var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + WIDGET_PATH + '";' +
  's.onerror=function(){try{localStorage.setItem("dsh-whale-bongo:widget-error","script-load")}catch(e){}};' +
  'd.appendChild(s)}catch(e){try{localStorage.setItem("dsh-whale-bongo:widget-error",String(e&&e.message||e))}catch(_){}}})()'

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

    // Desktop injection table: register before any await / service inject.
    const offIndex = root.on('webserver/index-inject', (table) => {
      diag.indexEvents += 1
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === WIDGET_PATH) {
            diag.indexDuplicates += 1
            return
          }
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_PATH) !== -1) {
            diag.indexDuplicates += 1
            return
          }
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
        diag.indexRows += 1
        diag.lastRowAt = Date.now()
      } catch {}
    })
    if (typeof offIndex === 'function') disposers.push(offIndex)

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

      // Web renderer injection.
      try {
        const offTap = ctx.webServer.tapIndex((html) => {
          diag.tapEvents += 1
          if (typeof html !== 'string' || html.indexOf(WIDGET_PATH) !== -1) return html
          diag.tapPages += 1
          diag.lastPageAt = Date.now()
          const probe = '<script>try{localStorage.setItem("dsh-whale-bongo:web-inject",String(Date.now()))}catch(e){}</script>'
          const tag = probe + '<script defer src="' + WIDGET_PATH + '"></script>'
          return html.indexOf('</body>') !== -1 ? html.replace('</body>', tag + '</body>') : html + tag
        })
        if (typeof offTap === 'function') disposers.push(offTap)
      } catch {}
    })
  },
}
