// Electron runtime discovery and on-demand installation.
//
// The desktop helper does not bundle Electron.  This module is shared by the
// Host and scripts/ensure-electron.mjs so both paths use the same pinned
// version, checksum verification, cancel logic, and atomic installation.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

export const DEFAULT_ELECTRON_VERSION = '43.3.0'

const USER_AGENT = 'dsh-whale-bongo-runtime/1'
const LOCK_STALE_MS = 30 * 60 * 1000

function homeRoot() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function requestedVersion() {
  return process.env.DSH_WHALE_ELECTRON_VERSION || DEFAULT_ELECTRON_VERSION
}

function targetDirectory(version) {
  return process.env.DSH_WHALE_ELECTRON_DIR ||
    path.join(homeRoot(), 'electron-whale', version)
}

function platformName() {
  return process.platform === 'win32' ? 'win32' : process.platform
}

function archiveName(version) {
  return 'electron-v' + version + '-' + platformName() + '-' + process.arch + '.zip'
}

export function electronIn(directory) {
  if (!directory) return null
  try {
    if (existsSync(directory) && statSync(directory).isFile()) return directory
  } catch {}
  const names = process.platform === 'win32'
    ? ['electron.exe']
    : process.platform === 'darwin'
      ? ['Electron', path.join('Electron.app', 'Contents', 'MacOS', 'Electron')]
      : ['electron']
  for (const name of names) {
    const candidate = path.join(directory, name)
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

export function findElectron() {
  const explicit = process.env.DSH_WHALE_ELECTRON || process.env.DSH_PET_ELECTRON
  const direct = electronIn(explicit)
  if (direct) return direct
  const customTarget = electronIn(process.env.DSH_WHALE_ELECTRON_DIR)
  if (customTarget) return customTarget
  const home = homeRoot()
  const roots = [
    path.join(home, 'electron-whale'),
    path.join(home, 'electron'),
  ]
  for (const root of roots) {
    const directRoot = electronIn(root)
    if (directRoot) return directRoot
    const current = electronIn(path.join(root, 'current'))
    if (current) return current
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    } catch {}
    for (const entry of entries) {
      const found = electronIn(path.join(root, entry))
      if (found) return found
    }
  }
  return null
}

function safeRemove(file, options) {
  try { rmSync(file, options) } catch {}
}

function safeUnlink(file) {
  try { unlinkSync(file) } catch {}
}

function sourceList(version) {
  const list = []
  const custom = process.env.DSH_WHALE_ELECTRON_MIRROR
  if (custom) {
    const base = custom.replace(/\/?$/, '/')
    list.push({
      name: '自定义镜像',
      url: (file) => base + version + '/' + file,
    })
  } else {
    const base = 'https://npmmirror.com/mirrors/electron/'
    list.push({
      name: 'npmmirror',
      url: (file) => base + version + '/' + file,
    })
  }
  list.push({
    name: 'GitHub',
    url: (file) => 'https://github.com/electron/electron/releases/download/v' + version + '/' + file,
  })
  const seen = new Set()
  return list.filter((item) => {
    const sample = item.url('SHASUMS256.txt')
    if (seen.has(sample)) return false
    seen.add(sample)
    return true
  })
}

function timedSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try { controller.abort(new Error('timeout')) } catch {}
  }, timeoutMs)
  timer.unref?.()
  let combined = controller.signal
  let onAbort = null
  if (typeof AbortSignal.any === 'function') {
    combined = AbortSignal.any([signal, controller.signal])
  } else if (signal) {
    onAbort = () => {
      try { controller.abort() } catch {}
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: combined,
    done() {
      clearTimeout(timer)
      if (onAbort) {
        try { signal.removeEventListener('abort', onAbort) } catch {}
      }
    },
  }
}

async function fetchText(url, signal) {
  const proxy = proxyFor(new URL(url))
  if (proxy) return proxyText(url, proxy, signal)
  const timeout = timedSignal(signal, 30000)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: timeout.signal,
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const text = await response.text()
    if (text.length > 1024 * 1024) throw new Error('response too large')
    return text
  } finally {
    timeout.done()
  }
}

function noProxyMatch(hostname) {
  const raw = process.env.NO_PROXY || process.env.no_proxy
  if (!raw) return false
  const host = String(hostname).toLowerCase()
  return raw.split(',').some((item) => {
    let entry = item.trim().toLowerCase()
    if (!entry) return false
    if (entry === '*') return true
    entry = entry.replace(/^\./, '').replace(/:\d+$/, '')
    return host === entry || host.endsWith('.' + entry)
  })
}

function proxyFor(target) {
  const raw = target.protocol === 'https:'
    ? (process.env.HTTPS_PROXY || process.env.https_proxy)
    : (process.env.HTTP_PROXY || process.env.http_proxy)
  if (!raw || noProxyMatch(target.hostname)) return null
  let proxy
  try { proxy = new URL(raw) } catch { throw new Error('代理地址格式不正确。') }
  if (proxy.protocol !== 'http:') {
    throw new Error('暂不支持 ' + proxy.protocol + ' 代理，请改用 HTTP 代理。')
  }
  return proxy
}

function proxyAuth(proxy) {
  if (!proxy.username && !proxy.password) return null
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
}

function proxyResponseOnce(target, proxy, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    let connectReq = null
    let tlsSocket = null
    let request = null
    let response = null

    const cleanup = () => {
      try { signal.removeEventListener('abort', abort) } catch {}
    }
    const fail = (error) => {
      if (!settled) {
        settled = true
        cleanup()
        reject(error)
      }
      try { response?.destroy() } catch {}
      try { request?.destroy() } catch {}
      try { tlsSocket?.destroy() } catch {}
      try { connectReq?.destroy() } catch {}
    }
    const abort = () => {
      const error = new Error('cancelled')
      error.name = 'AbortError'
      fail(error)
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })

    const auth = proxyAuth(proxy)
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80')
    try {
      connectReq = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: 'CONNECT',
        path: target.hostname + ':' + targetPort,
        headers: {
          Host: target.hostname + ':' + targetPort,
          ...(auth ? { 'Proxy-Authorization': auth } : {}),
        },
      })
    } catch (error) {
      fail(error)
      return
    }
    connectReq.setTimeout(30000, () => connectReq.destroy(new Error('timeout')))
    connectReq.once('error', fail)
    connectReq.once('connect', (res, socket) => {
      connectReq.setTimeout(0)
      socket.setTimeout(0)
      if (res.statusCode !== 200) {
        socket.destroy()
        fail(new Error('代理连接失败（HTTP ' + res.statusCode + '）'))
        return
      }
      tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        try {
          const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
          agent.createConnection = () => tlsSocket
          request = https.request(target, {
            method: 'GET',
            agent,
            headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
          }, (incoming) => {
            request.setTimeout(0)
            response = incoming
            settled = true
            incoming.once('close', cleanup)
            resolve({
              statusCode: incoming.statusCode,
              headers: incoming.headers,
              stream: incoming,
            })
          })
          request.setTimeout(30000, () => request.destroy(new Error('timeout')))
          request.once('error', fail)
          request.end()
        } catch (error) {
          fail(error)
        }
      })
      tlsSocket.once('error', fail)
    })
    connectReq.end()
  })
}

async function proxyResponse(target, proxy, signal, redirects = 0) {
  const response = await proxyResponseOnce(target, proxy, signal)
  const location = response.headers.location
  if (
    location &&
    (response.statusCode === 301 || response.statusCode === 302 ||
      response.statusCode === 303 || response.statusCode === 307 ||
      response.statusCode === 308)
  ) {
    response.stream.resume()
    if (redirects >= 5) throw new Error('重定向次数过多')
    const next = new URL(location, target)
    return proxyResponse(next, proxyFor(next) || proxy, signal, redirects + 1)
  }
  return response
}

async function proxyText(url, proxy, signal) {
  const response = await proxyResponse(new URL(url), proxy, signal)
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.stream.resume()
    throw new Error('HTTP ' + response.statusCode)
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.stream) {
    size += chunk.length
    if (size > 1024 * 1024) {
      response.stream.destroy()
      throw new Error('response too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function saveStream(stream, total, zip, expected, onProgress, checkCancel) {
  const hash = createHash('sha256')
  const out = createWriteStream(zip, { flags: 'wx' })
  let streamError = null
  out.on('error', (error) => { streamError = error })
  let received = 0
  try {
    for await (const chunk of stream) {
      checkCancel()
      hash.update(chunk)
      received += chunk.length
      onProgress(received, total)
      if (!out.write(chunk)) await once(out, 'drain')
    }
    if (streamError) throw streamError
    await new Promise((resolve, reject) => {
      out.once('error', reject)
      out.end(resolve)
    })
  } catch (error) {
    out.destroy()
    throw error
  }
  const actual = hash.digest('hex').toLowerCase()
  if (actual !== expected) {
    throw new Error('下载文件 SHA-256 校验失败')
  }
  return received
}

async function proxyDownload(url, proxy, file, zip, signal, expected, onProgress, checkCancel) {
  const response = await proxyResponse(new URL(url), proxy, signal)
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.stream.resume()
    throw new Error('HTTP ' + response.statusCode)
  }
  const total = Number(response.headers['content-length']) || 0
  onProgress(0, total)
  return saveStream(response.stream, total, zip, expected, onProgress, checkCancel)
}

function parseChecksum(text, file) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())
    if (match && match[2] === file) return match[1].toLowerCase()
  }
  return null
}

function executableInTree(directory) {
  return electronIn(directory)
}

function extractZip(zip, target, signal, onChild) {
  return new Promise((resolve, reject) => {
    const args = process.platform === 'win32'
      ? [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          'Expand-Archive -LiteralPath ' + quotePowerShell(zip) +
            ' -DestinationPath ' + quotePowerShell(target) + ' -Force',
        ]
      : ['-q', '-o', zip, '-d', target]
    const command = process.platform === 'win32' ? 'powershell.exe' : 'unzip'
    let child
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    onChild(child)
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += String(chunk)
    })
    const abort = () => {
      try { child.kill() } catch {}
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('exit', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) {
        reject(new Error('cancelled'))
        return
      }
      if (code === 0) resolve()
      else {
        const error = new Error('Electron 解压失败。')
        error.detail = stderr.trim().slice(0, 500)
        reject(error)
      }
    })
  })
}

function quotePowerShell(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function acquireLock() {
  const directory = path.join(homeRoot(), 'electron-whale')
  const file = path.join(directory, '.prepare.lock')
  const token = String(process.pid) + '-' + Date.now() + '-' + Math.random().toString(16).slice(2)
  mkdirSync(directory, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx')
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }))
      } finally {
        closeSync(fd)
      }
      return { file, token }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      let data = null
      try { data = JSON.parse(readFileSync(file, 'utf8')) } catch {}
      const age = data && Number.isFinite(data.at) ? Date.now() - data.at : Infinity
      if (data && processAlive(Number(data.pid)) && age < LOCK_STALE_MS) {
        throw new Error('另一个 DSH 实例正在准备桌面运行时，请稍后再试。')
      }
      safeUnlink(file)
    }
  }
  throw new Error('无法锁定 Electron 安装目录，请稍后再试。')
}

function releaseLock(lock) {
  if (!lock) return
  try {
    const data = JSON.parse(readFileSync(lock.file, 'utf8'))
    if (data && data.token === lock.token) safeUnlink(lock.file)
  } catch {}
}

function friendlyError(error) {
  if (!error) return '未知错误'
  if (error.code === 'ENOSPC') return '磁盘空间不足，无法准备桌面运行时。'
  if (error.code === 'EACCES' || error.code === 'EPERM') return '没有权限写入 Electron 安装目录。'
  return error.message ? String(error.message) : String(error)
}

export function createElectronPreparer(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  let running = null
  let controller = null
  let extractChild = null
  let cancelRequested = false
  let lastNotify = 0
  let status = {
    state: 'idle',
    version: requestedVersion(),
    received: 0,
    total: 0,
    percent: 0,
    error: null,
    path: null,
    target: null,
    source: null,
    startedAt: 0,
  }

  function snapshot() {
    return { ...status }
  }

  function update(patch, force) {
    status = { ...status, ...patch }
    if (status.total > 0) status.percent = Math.min(100, Math.round((status.received / status.total) * 100))
    else if (status.state === 'ready') status.percent = 100
    else status.percent = 0
    const now = Date.now()
    if (onProgress && (force || now - lastNotify >= 100)) {
      lastNotify = now
      try { onProgress(snapshot()) } catch {}
    }
  }

  function progress(received, total) {
    update({ received, total: total || status.total })
  }

  function throwIfCancelled() {
    if (cancelRequested) {
      const error = new Error('cancelled')
      error.name = 'AbortError'
      throw error
    }
  }

  async function resolveVersion(signal) {
    const requested = requestedVersion()
    if (requested !== 'latest') return requested
    const registry = process.env.DSH_WHALE_ELECTRON_REGISTRY ||
      'https://registry.npmmirror.com/electron/latest'
    const text = await fetchText(registry, signal)
    let data
    try { data = JSON.parse(text) } catch {}
    if (!data || typeof data.version !== 'string' || !data.version) {
      throw new Error('无法解析最新 Electron 版本，请稍后重试。')
    }
    return data.version
  }

  async function findChecksum(sources, file, signal) {
    const failures = []
    for (const source of sources) {
      throwIfCancelled()
      try {
        const text = await fetchText(source.url('SHASUMS256.txt'), signal)
        const checksum = parseChecksum(text, file)
        if (checksum) return checksum
        failures.push(source.name + ': 校验文件中没有 ' + file)
      } catch (error) {
        if (cancelRequested) throw error
        failures.push(source.name + ': ' + friendlyError(error))
      }
    }
    log('checksum lookup failed: ' + failures.join(' | '))
    throw new Error('无法获取 Electron 校验文件，请检查网络后重试。')
  }

  async function download(source, file, zip, signal, expected) {
    const url = source.url(file)
    const proxy = proxyFor(new URL(url))
    update({ received: 0, total: 0, source: source.name })
    if (proxy) {
      return proxyDownload(url, proxy, file, zip, signal, expected, progress, throwIfCancelled)
    }
    const timeout = timedSignal(signal, 30000)
    let response
    try {
      response = await fetch(url, {
        redirect: 'follow',
        signal: timeout.signal,
        headers: { 'User-Agent': USER_AGENT },
      })
    } finally {
      timeout.done()
    }
    if (!response.ok || !response.body) {
      throw new Error('HTTP ' + response.status)
    }
    const total = Number(response.headers.get('content-length')) || 0
    update({ received: 0, total, source: source.name })
    return saveStream(
      Readable.fromWeb(response.body),
      total,
      zip,
      expected,
      progress,
      throwIfCancelled,
    )
  }

  async function run() {
    let lock = null
    let zip = null
    let staging = null
    let downloadsDir = null
    let target = null
    try {
      const existing = findElectron()
      if (existing) {
        update({
          state: 'ready',
          path: existing,
          target: path.dirname(existing),
          percent: 100,
          error: null,
        }, true)
        return snapshot()
      }

      lock = acquireLock()
      controller = new AbortController()
      cancelRequested = false
      update({
        state: 'downloading',
        received: 0,
        total: 0,
        error: null,
        path: null,
        source: null,
        startedAt: Date.now(),
      }, true)

      const version = await resolveVersion(controller.signal)
      throwIfCancelled()
      target = targetDirectory(version)
      const existingTarget = executableInTree(target)
      if (existingTarget) {
        update({ state: 'ready', version, path: existingTarget, target, percent: 100 }, true)
        return snapshot()
      }

      const file = archiveName(version)
      const sources = sourceList(version)
      update({ version, target, state: 'downloading' }, true)
      const checksum = await findChecksum(sources, file, controller.signal)
      throwIfCancelled()

      const parent = path.dirname(target)
      mkdirSync(parent, { recursive: true })
      const stamp = process.pid + '-' + Date.now()
      const downloads = path.join(parent, '.downloads')
      mkdirSync(downloads, { recursive: true })
      downloadsDir = downloads
      zip = path.join(downloads, 'electron-' + version + '-' + stamp + '.zip')
      staging = path.join(parent, '.electron-staging-' + stamp)
      mkdirSync(staging, { recursive: true })

      let lastError = null
      for (const source of sources) {
        throwIfCancelled()
        safeUnlink(zip)
        try {
          log('downloading ' + file + ' from ' + source.name)
          await download(source, file, zip, controller.signal, checksum)
          lastError = null
          break
        } catch (error) {
          if (cancelRequested) throw error
          lastError = error
          log(source.name + ' failed: ' + friendlyError(error))
        }
      }
      if (lastError) {
        throw new Error('Electron 下载失败，请检查网络后重试。')
      }

      throwIfCancelled()
      update({ state: 'extracting', source: status.source, received: status.total || status.received }, true)
      await extractZip(zip, staging, controller.signal, (child) => { extractChild = child })
      extractChild = null
      throwIfCancelled()

      const extracted = executableInTree(staging)
      if (!extracted) throw new Error('Electron 解压后未找到可执行文件。')
      writeFileSync(path.join(staging, '.dsh-whale-electron.json'), JSON.stringify({
        version,
        archive: file,
        sha256: checksum,
        installedAt: new Date().toISOString(),
      }))

      if (existsSync(target) && !executableInTree(target)) {
        safeRemove(target, { recursive: true, force: true })
      }
      try {
        renameSync(staging, target)
      } catch (error) {
        if (!executableInTree(target)) throw error
      }
      const installed = executableInTree(target)
      if (!installed) throw new Error('Electron 安装后未找到可执行文件。')
      staging = null
      update({
        state: 'ready',
        version,
        path: installed,
        target,
        total: status.received || status.total,
        received: status.received || status.total,
        percent: 100,
        error: null,
      }, true)
      log('installed Electron ' + version + ' at ' + target)
      return snapshot()
    } catch (error) {
      if (cancelRequested) {
        update({ state: 'cancelled', error: '已取消准备桌面运行时。' }, true)
      } else {
        log('prepare failed: ' + friendlyError(error))
        update({ state: 'failed', error: friendlyError(error) }, true)
      }
      return snapshot()
    } finally {
      running = null
      extractChild = null
      controller = null
      if (zip) safeUnlink(zip)
      if (staging) safeRemove(staging, { recursive: true, force: true })
      if (downloadsDir) {
        try {
          if (!readdirSync(downloadsDir).length) safeRemove(downloadsDir, { recursive: true, force: true })
        } catch {}
      }
      if (lock) releaseLock(lock)
    }
  }

  function start() {
    if (running) return snapshot()
    const existing = findElectron()
    if (existing) {
      update({ state: 'ready', path: existing, target: path.dirname(existing), percent: 100, error: null }, true)
      return snapshot()
    }
    cancelRequested = false
    running = run()
    return snapshot()
  }

  function cancel() {
    if (!running) return snapshot()
    cancelRequested = true
    try { controller?.abort() } catch {}
    try { extractChild?.kill() } catch {}
    update({ state: 'cancelled', error: '已取消准备桌面运行时。' }, true)
    return snapshot()
  }

  async function wait() {
    if (running) {
      try { await running } catch {}
    }
    return snapshot()
  }

  function dispose() {
    try { cancel() } catch {}
  }

  return {
    state: snapshot,
    start,
    cancel,
    wait,
    dispose,
  }
}
