#!/usr/bin/env node
/*
 * Standalone viewer for the widget's live rhythm detector.
 *
 * The widget exposes telemetry on the helper's loopback bridge. This server
 * discovers that bridge from the helper's temp file and serves a small UI plus
 * an SSE proxy. It deliberately does not capture audio itself: every number in
 * the UI comes from the running plugin.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const HOST = process.env.BEAT_LIVE_HOST || '127.0.0.1'
const PORT = Number(process.env.BEAT_LIVE_PORT || 8898)
const INFO_PATH = path.join(os.tmpdir(), 'dsh-whale-bongo-bridge.json')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function bridgeInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8'))
    if (!info || !info.port) return null
    return info
  } catch {
    return null
  }
}

function helperUrl(info, pathname) {
  return `http://127.0.0.1:${Number(info.port)}${pathname}`
}

async function helperState(info) {
  const response = await fetch(helperUrl(info, '/audio-beat/state'), {
    signal: AbortSignal.timeout(1800),
  })
  if (!response.ok) throw new Error(`helper HTTP ${response.status}`)
  return response.json()
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function serveFile(res, pathname) {
  const relative = pathname === '/' ? 'beat-live.html' : pathname.replace(/^\/+/, '')
  const file = path.resolve(ROOT, relative)
  if (!file.startsWith(ROOT + path.sep)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  let data
  try { data = fs.readFileSync(file) } catch {
    sendJson(res, 404, { ok: false, error: 'not found' })
    return
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  if (url.pathname === '/api/info') {
    const info = bridgeInfo()
    if (!info) {
      sendJson(res, 503, {
        ok: false,
        error: '没有找到正在运行的挂件 helper。请先在桌面模式下启用音乐律动。',
      })
      return
    }
    helperState(info).then((state) => {
      sendJson(res, 200, {
        ok: true,
        bridge: info,
        state,
        sample: state && state.telemetry ? state.telemetry : null,
      })
    }).catch((error) => {
      sendJson(res, 502, { ok: false, error: String(error && error.message || error), bridge: info })
    })
    return
  }
  if (url.pathname === '/api/stream') {
    const info = bridgeInfo()
    if (!info) {
      sendJson(res, 503, { ok: false, error: 'helper not running' })
      return
    }
    const upstream = http.get(helperUrl(info, '/audio-beat/stream'), (upstreamRes) => {
      if (upstreamRes.statusCode !== 200) {
        upstreamRes.resume()
        sendJson(res, 502, { ok: false, error: 'helper stream unavailable' })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      upstreamRes.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'helper connection failed' })
      else res.end()
    })
    req.on('close', () => upstream.destroy())
    req.on('error', () => upstream.destroy())
    return
  }
  serveFile(res, url.pathname)
})

server.listen(PORT, HOST, () => {
  console.log(`Whale Beat Live: http://${HOST}:${PORT}/`)
  console.log(`bridge discovery: ${INFO_PATH}`)
})
