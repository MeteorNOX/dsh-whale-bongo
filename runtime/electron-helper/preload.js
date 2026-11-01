const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whaleDesktop', {
  onConfig(callback) {
    ipcRenderer.on('whale:config', (_event, snapshot) => callback(snapshot))
  },
  onKey(callback) {
    ipcRenderer.on('whale:key', (_event, payload) => callback(payload))
  },
  onBlur(callback) {
    ipcRenderer.on('whale:blur', () => callback())
  },
  onReleaseAll(callback) {
    ipcRenderer.on('whale:release-all', () => callback())
  },
  setMenuOpen(open) {
    ipcRenderer.send('whale:menu-open', Boolean(open))
  },
  ready() {
    ipcRenderer.send('whale:ready')
  },
  sendConfig(snapshot) {
    ipcRenderer.send('whale:config', snapshot)
  },
  setInteractive(interactive) {
    ipcRenderer.send('whale:interactive', Boolean(interactive))
  },
  beginDrag(x, y) {
    ipcRenderer.send('whale:drag-start', { x, y })
  },
  moveDrag(x, y) {
    ipcRenderer.send('whale:drag-move', { x, y })
  },
  endDrag() {
    ipcRenderer.send('whale:drag-end')
  },
})
