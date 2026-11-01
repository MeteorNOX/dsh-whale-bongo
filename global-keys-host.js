// Global keyboard sampler for the browser half.  The desktop helper has its
// own copy; this one exists while the plugin runs in DSH so IMEs that swallow
// page key events (for example Sogou) can still drive the widget.

import { spawn } from 'node:child_process'
import path from 'node:path'

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

export function createGlobalKeyMonitor({ pkgRoot, onKey, log = () => {} }) {
  let child = null
  let buffer = ''
  let restartTimer = null
  let stopped = false
  let failures = 0

  function handleLine(line) {
    const parts = line.trim().split('|')
    if (parts.length !== 6) return
    const down = parts[0] === '1'
    const vk = Number(parts[1])
    if (!Number.isInteger(vk)) return
    if (vk < 8 || vk === 16 || vk === 17 || vk === 18 || vk === 20 ||
        vk === 91 || vk === 92 || vk === 144 || vk === 145) return
    const code = vkCode(vk)
    try {
      onKey({
        action: down ? 'down' : 'up',
        key: code,
        code: code,
        ctrlKey: parts[2] === '1',
        altKey: parts[3] === '1',
        shiftKey: parts[4] === '1',
        metaKey: parts[5] === '1',
      })
    } catch (error) {
      log('global key dispatch: ' + String(error))
    }
  }

  function spawnMonitor() {
    if (process.platform !== 'win32' || stopped || child) return
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', path.join(pkgRoot, 'runtime', 'electron-helper', 'global-keys.ps1'),
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      child = null
      log('global key monitor failed: ' + String(error))
      return
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) handleLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log('global key stderr: ' + text.slice(0, 500))
    })
    child.once('exit', () => {
      child = null
      buffer = ''
      if (stopped) return
      failures += 1
      const delay = Math.min(5000, 500 * failures)
      restartTimer = setTimeout(() => {
        restartTimer = null
        spawnMonitor()
      }, delay)
      restartTimer.unref?.()
    })
  }

  function start() {
    stopped = false
    spawnMonitor()
  }

  function stop() {
    stopped = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (child) {
      try { child.kill() } catch {}
      child = null
    }
    buffer = ''
  }

  return { start, stop }
}
