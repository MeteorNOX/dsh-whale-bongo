// Optional, zero-dependency Electron bootstrap for the desktop helper.
//
// Run after installing the plugin:
//   node scripts/ensure-electron.mjs
//
// Environment overrides:
//   DSH_WHALE_ELECTRON              existing executable path or directory
//   DSH_WHALE_ELECTRON_VERSION      exact version (default: pinned 43.3.0)
//   DSH_WHALE_ELECTRON_DIR          install directory
//   DSH_WHALE_ELECTRON_MIRROR       mirror base
//   DSH_WHALE_ELECTRON_REGISTRY     npm-registry metadata URL for "latest"

import { createElectronPreparer, findElectron } from '../electron-runtime.js'

const existing = findElectron()
if (existing) {
  console.log(existing)
  process.exit(0)
}

let lastPercent = -1
const runtime = createElectronPreparer({
  log: (message) => console.error(message),
  onProgress: (state) => {
    if (state.state === 'downloading' && state.percent !== lastPercent) {
      lastPercent = state.percent
      const total = state.total ? ' / ' + Math.round(state.total / 1048576) + ' MB' : ''
      process.stderr.write('\r下载 Electron ' + state.version + '：' + state.percent + '%' +
        ' (' + Math.round(state.received / 1048576) + ' MB' + total + ')')
    }
  },
})

process.once('SIGINT', () => {
  runtime.cancel()
  process.stderr.write('\n已取消。\n')
  setTimeout(() => process.exit(130), 200).unref?.()
})

runtime.start()
const state = await runtime.wait()
if (state.state !== 'ready') {
  process.stderr.write('\n' + (state.error || 'Electron 运行时准备失败。') + '\n')
  process.exitCode = 1
} else {
  process.stderr.write('\n')
  console.log(state.path)
}
