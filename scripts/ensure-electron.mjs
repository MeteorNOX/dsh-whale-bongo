// Optional, zero-dependency Electron bootstrap for the desktop helper.
//
// Run after installing the plugin:
//   node scripts/ensure-electron.mjs
//
// Environment overrides:
//   DSH_WHALE_ELECTRON              existing executable path
//   DSH_WHALE_ELECTRON_VERSION      exact version (default: latest)
//   DSH_WHALE_ELECTRON_DIR          install directory
//   DSH_WHALE_ELECTRON_MIRROR       mirror base
//   DSH_WHALE_ELECTRON_REGISTRY     npm-registry metadata URL for "latest"

import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const requested = process.env.DSH_WHALE_ELECTRON_VERSION || 'latest'
const MIRROR = process.env.DSH_WHALE_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
const REGISTRY = process.env.DSH_WHALE_ELECTRON_REGISTRY || 'https://registry.npmmirror.com/electron/latest'

function executableIn(directory) {
  const names = process.platform === 'win32'
    ? ['electron.exe']
    : process.platform === 'darwin'
      ? ['Electron', join('Electron.app', 'Contents', 'MacOS', 'Electron')]
      : ['electron']
  for (const name of names) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function resolveVersion() {
  if (requested !== 'latest') return requested
  const response = await fetch(REGISTRY, { redirect: 'follow' })
  if (!response.ok) throw new Error('cannot resolve latest Electron version: HTTP ' + response.status)
  const data = await response.json()
  if (!data || typeof data.version !== 'string' || !data.version) {
    throw new Error('cannot resolve latest Electron version from ' + REGISTRY)
  }
  return data.version
}

function archiveName(version) {
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  return 'electron-v' + version + '-' + platform + '-' + process.arch + '.zip'
}

function extractZip(zip, target) {
  if (process.platform === 'win32') {
    const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'"
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      'Expand-Archive -LiteralPath ' + quote(zip) + ' -DestinationPath ' + quote(target) + ' -Force',
    ], { stdio: 'inherit' })
    return
  }
  execFileSync('unzip', ['-q', '-o', zip, '-d', target], { stdio: 'inherit' })
}

const explicit = process.env.DSH_WHALE_ELECTRON
if (explicit && existsSync(explicit)) {
  const found = executableIn(explicit) || explicit
  console.log(found)
  process.exit(0)
}

const version = await resolveVersion()
const target = process.env.DSH_WHALE_ELECTRON_DIR || join(HOME, 'electron-whale', version)
const existing = executableIn(target)
if (existing) {
  console.log(existing)
  process.exit(0)
}

mkdirSync(target, { recursive: true })
const zip = join(tmpdir(), 'dsh-whale-electron-' + version + '-' + process.pid + '.zip')
const url = MIRROR.replace(/\/?$/, '/') + version + '/' + archiveName(version)
console.log('downloading Electron ' + version + ' from ' + url)
try {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error('download failed: HTTP ' + response.status + ' ' + url)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zip))
  extractZip(zip, target)
} finally {
  try { rmSync(zip, { force: true }) } catch {}
}

const executable = executableIn(target)
if (!executable) {
  throw new Error('Electron extracted but executable was not found in ' + target)
}
console.log(executable)
