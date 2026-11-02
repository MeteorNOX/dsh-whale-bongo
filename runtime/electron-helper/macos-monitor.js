'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

// Compile the tiny native sampler once per source/OS/architecture in a private
// cache. Keep generated executables out of the installed package and Git.
function createMacOSMonitor({ onSample, onError = () => {} }) {
  let stopped = true
  let child = null
  let generation = 0
  let retryTimer = null
  let failures = 0

  async function executable(run) {
    const source = path.join(__dirname, 'desktop-macos.m')
    const data = await fs.readFile(source)
    const hash = createHash('sha256').update(data).update(process.arch + os.release()).digest('hex').slice(0, 20)
    const directory = path.join(os.tmpdir(), 'dsh-whale-bongo-native-' + process.getuid())
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw new Error('macOS 窗口监听缓存目录权限不正确。')
    }
    const target = path.join(directory, 'desktop-' + hash)
    try { await fs.access(target, 1); return target } catch {}
    if (stopped || run !== generation) return null
    const temporary = target + '-' + randomUUID()
    try {
      await new Promise((resolve, reject) => {
        const compiler = spawn('/usr/bin/xcrun', [
          'clang', '-O2', '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'CoreGraphics',
          source, '-o', temporary,
        ], { stdio: ['ignore', 'ignore', 'ignore'] })
        child = compiler
        const timeout = setTimeout(() => compiler.kill(), 30000)
        compiler.once('error', reject)
        compiler.once('close', (code) => {
          clearTimeout(timeout)
          if (child === compiler) child = null
          if (code === 0) resolve()
          else reject(new Error('无法编译 macOS 窗口监听器，请确认已安装 Xcode Command Line Tools。'))
        })
      })
      await fs.chmod(temporary, 0o700)
      await fs.rename(temporary, target)
      return target
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  async function launch(run) {
    try {
      const binary = await executable(run)
      if (!binary || stopped || run !== generation) return
      const proc = spawn(binary, [String(process.pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
      child = proc
      let buffer = ''
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => {
        if (stopped || run !== generation) return
        buffer += chunk
        if (buffer.length > 2 * 1024 * 1024) { buffer = ''; return }
        let index
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          let sample
          try { sample = JSON.parse(line) } catch { continue }
          failures = 0
          onSample(sample)
        }
      })
      proc.once('error', () => onError('macOS 窗口监听器启动失败。'))
      proc.once('close', () => {
        if (child === proc) child = null
        if (stopped || run !== generation) return
        onError('macOS 窗口监听器已退出，正在重试。')
        retryTimer = setTimeout(() => { retryTimer = null; launch(run) }, Math.min(5000, 500 * ++failures))
        retryTimer.unref?.()
      })
    } catch (error) {
      if (!stopped && run === generation) onError(error.message)
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      launch(++generation)
    },
    stop() {
      stopped = true
      generation += 1
      clearTimeout(retryTimer)
      retryTimer = null
      if (child) child.kill()
      child = null
    },
  }
}

module.exports = { createMacOSMonitor }
