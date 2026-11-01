const bridge = window.whaleDesktop
const STORE = 'dsh-dsniang-bongo:widget:v3'
const IMAGE_STORE = 'dsh-dsniang-bongo:widget-image:v3'
const SOUND_STORE = 'dsh-dsniang-bongo:widget-sound:v1'

window.__DSH_WHALE_KEY_ANGLES_URL = '../../assets/key-angles.json'

let mounted = false
let configTimer = 0
let interactive = false

function readSnapshot() {
  let cfg = null
  try { cfg = JSON.parse(localStorage.getItem(STORE) || 'null') } catch {}
  return {
    cfg,
    image: localStorage.getItem(IMAGE_STORE),
    sound: localStorage.getItem(SOUND_STORE),
  }
}

function sendSnapshot() {
  if (configTimer) return
  configTimer = setTimeout(() => {
    configTimer = 0
    try { bridge.sendConfig(readSnapshot()) } catch {}
  }, 150)
}

window.__dshWhaleBongoDesktopChanged = sendSnapshot

function applySnapshot(snapshot) {
  if (!snapshot || !snapshot.cfg) return
  try {
    localStorage.setItem(STORE, JSON.stringify(snapshot.cfg))
    if (snapshot.image) localStorage.setItem(IMAGE_STORE, snapshot.image)
    else localStorage.removeItem(IMAGE_STORE)
    if (snapshot.sound) localStorage.setItem(SOUND_STORE, snapshot.sound)
    else localStorage.removeItem(SOUND_STORE)
  } catch {}
  if (snapshot.cfg.displayMode === 'web') {
    try { bridge.sendConfig(snapshot) } catch {}
    return
  }
  if (mounted) return
  mounted = true
  try {
    window.__dshWhaleBongoDesktopInput = null
    const dispose = window.mountWhaleBongoWidget({ desktop: true })
    window.__dshWhaleBongoDesktopDispose = dispose
  } catch (error) {
    try {
      bridge.sendConfig({ cfg: { error: String(error && error.message ? error.message : error) } })
    } catch {}
  }
}

function updateInteractive(event) {
  if (window.__dshWhaleBongoDesktopDragging) {
    if (!interactive) {
      interactive = true
      try { bridge.setInteractive(true) } catch {}
    }
    return
  }
  const target = document.elementFromPoint(event.clientX, event.clientY)
  const next = Boolean(target && target.closest && target.closest('#dsh-whale-bongo'))
  if (next === interactive) return
  interactive = next
  try { bridge.setInteractive(interactive) } catch {}
}

window.addEventListener('pointermove', updateInteractive, true)
window.addEventListener('pointerleave', () => {
  if (!interactive) return
  interactive = false
  try { bridge.setInteractive(false) } catch {}
})

bridge.onConfig(applySnapshot)
bridge.onBlur(() => {
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.closeMenu?.() } catch {}
})

bridge.onReleaseAll(() => {
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.releaseAll?.() } catch {}
})

bridge.onKey((payload) => {
  const api = window.__dshWhaleBongoDesktopInput
  if (!api || !payload) return
  try {
    if (payload.action === 'down') api.keydown(payload)
    else api.keyup(payload)
  } catch {}
})

window.addEventListener('beforeunload', () => {
  try {
    window.__dshWhaleBongoDesktopDispose?.()
  } catch {}
})

bridge.ready()
