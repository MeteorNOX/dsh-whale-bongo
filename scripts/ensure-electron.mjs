// Optional Electron bootstrap for the desktop helper.
//
// Run after installing the plugin:
//   node scripts/ensure-electron.mjs
//
// The helper itself never downloads anything at runtime.  On Windows the
// default target is ~/.dsh/electron-whale/43.3.0, matching desktop.js.

import { downloadArtifact } from '@electron/get'
import extract from '@electron-internal/extract-zip'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERSION = process.env.DSH_WHALE_ELECTRON_VERSION || '43.3.0'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const TARGET = process.env.DSH_WHALE_ELECTRON_DIR || join(HOME, 'electron-whale', VERSION)
const EXE = join(TARGET, process.platform === 'win32' ? 'electron.exe' : 'electron')
const MIRROR = process.env.DSH_WHALE_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'

if (existsSync(EXE)) {
  console.log(EXE)
  process.exit(0)
}

mkdirSync(TARGET, { recursive: true })
console.log('downloading Electron ' + VERSION + ' -> ' + TARGET)
const zip = await downloadArtifact({
  version: VERSION,
  artifactName: 'electron',
  platform: process.platform,
  arch: process.arch,
  mirror: MIRROR,
})
await extract(zip, { dir: TARGET })
if (!existsSync(EXE)) {
  throw new Error('Electron extracted but executable was not found: ' + EXE)
}
console.log(EXE)
