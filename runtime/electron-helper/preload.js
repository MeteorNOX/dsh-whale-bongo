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
  ready() {
    ipcRenderer.send('whale:ready')
  },
  sendConfig(snapshot) {
    ipcRenderer.send('whale:config', snapshot)
  },
  stopDesktop() {
    ipcRenderer.send('whale:stop')
  },
  setInteractive(interactive) {
    ipcRenderer.send('whale:interactive', Boolean(interactive))
  },
})
