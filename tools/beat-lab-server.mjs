import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const port = Number(process.env.BEAT_LAB_PORT || 8899)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent((req.url || '/').split('?')[0])
  if (pathname === '/') {
    res.writeHead(302, { location: '/tools/beat-lab.html' })
    res.end()
    return
  }
  const target = path.resolve(root, pathname.replace(/^\/+/, ''))
  if (!target.startsWith(root + path.sep)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': types[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(data)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log('Whale Beat Lab: http://127.0.0.1:' + port + '/')
  console.log('Ctrl+C to stop')
})
