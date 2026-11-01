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
  onGlobalKeys(callback) {
    ipcRenderer.on('whale:global-keys', () => callback())
  },
  onWindows(callback) {
    ipcRenderer.on('whale:windows', (_event, list) => callback(list))
  },
  onInputAnchor(callback) {
    ipcRenderer.on('whale:input-anchor', (_event, anchor) => callback(anchor))
  },
  onMouseFollow(callback) {
    ipcRenderer.on('whale:mouse-follow', (_event, payload) => callback(payload))
  },
  ready() {
    ipcRenderer.send('whale:ready')
  },
  sendConfig(snapshot) {
    ipcRenderer.send('whale:config', snapshot)
  },
  stopDesktop(snapshot) {
    ipcRenderer.send('whale:stop', snapshot || null)
  },
  setInteractive(interactive) {
    ipcRenderer.send('whale:interactive', Boolean(interactive))
  },
})
