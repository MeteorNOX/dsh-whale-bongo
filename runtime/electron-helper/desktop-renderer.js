const bridge = window.whaleDesktop
const STORE = 'dsh-dsniang-bongo:widget:v3'
const IMAGE_STORE = 'dsh-dsniang-bongo:widget-image:v3'
const SOUND_STORE = 'dsh-dsniang-bongo:widget-sound:v1'

window.__DSH_WHALE_KEY_ANGLES_URL = '../../assets/key-angles.json'

let mounted = false
let configTimer = 0
let pendingSnapshot = null
let interactive = false
let audioBeatDetector = null
let audioBeatWanted = false
let audioBeatStatus = 'stopped'
let audioBeatError = ''
let audioBeatBpm = 0

function audioBeatApi() {
  return window.__dshWhaleBongoDesktopInput || null
}

function publishAudioBeatTelemetry(payload) {
  if (!payload || typeof payload !== 'object') return
  window.__DSH_WHALE_AUDIO_BEAT_LIVE = payload
  try { bridge?.audioBeatTelemetry?.(payload) } catch {}
}

function publishAudioBeatStatus(state, detail, bpm) {
  audioBeatStatus = state || 'stopped'
  audioBeatError = detail || ''
  audioBeatBpm = isFinite(bpm) ? Number(bpm) : 0
  window.__DSH_WHALE_AUDIO_BEAT_STATUS = {
    state: audioBeatStatus,
    error: audioBeatError,
    bpm: audioBeatBpm,
  }
  const api = audioBeatApi()
  try { api?.setAudioBeatStatus?.(audioBeatStatus, audioBeatError, audioBeatBpm) } catch {}
}

function stopAudioBeat() {
  audioBeatWanted = false
  if (audioBeatDetector) {
    try { audioBeatDetector.stop() } catch {}
  }
  const api = audioBeatApi()
  try { api?.setAudioBeatEnabled?.(false) } catch {}
}

function startAudioBeat() {
  if (!audioBeatWanted || !window.createWhaleAudioBeat) return
  if (!audioBeatDetector) {
    audioBeatDetector = window.createWhaleAudioBeat({
      onBeat(payload) {
        if (!audioBeatWanted) return
        const strength = payload && isFinite(payload.strength) ? payload.strength : 0.5
        window.__DSH_WHALE_AUDIO_BEAT = payload
        const api = audioBeatApi()
        try { api?.beat?.(strength) } catch {}
      },
      onStatus(payload) {
        publishAudioBeatStatus(
          payload && payload.state,
          payload && payload.error,
          payload && payload.bpm
        )
      },
      onTelemetry(payload) {
        if (!audioBeatWanted) return
        publishAudioBeatTelemetry(payload)
        const api = audioBeatApi()
        if (api && typeof api.setAudioEnergy === 'function') {
          try { api.setAudioEnergy(payload && payload.energy) } catch {}
        }
        if (api && typeof api.setAudioBands === 'function') {
          try { api.setAudioBands(payload && payload.bands) } catch {}
        }
      },
    })
  }
  const api = audioBeatApi()
  try { api?.setAudioBeatEnabled?.(true) } catch {}
  audioBeatDetector.start()
}

function applyAudioBeatState(payload) {
  const enabled = !payload || payload.enabled !== false
  window.__DSH_WHALE_AUDIO_BEAT_ENABLED = enabled
  if (!enabled) {
    stopAudioBeat()
    return
  }
  audioBeatWanted = true
  startAudioBeat()
}

function readSnapshot() {
  let cfg = null
  try { cfg = JSON.parse(localStorage.getItem(STORE) || 'null') } catch {}
  return {
    cfg,
    image: localStorage.getItem(IMAGE_STORE),
    sound: localStorage.getItem(SOUND_STORE),
  }
}

function sendSnapshot(snapshot) {
  if (snapshot) pendingSnapshot = snapshot
  if (configTimer) return
  configTimer = setTimeout(() => {
    configTimer = 0
    var next = pendingSnapshot || readSnapshot()
    pendingSnapshot = null
    try { bridge.sendConfig(next) } catch {}
  }, 150)
}

window.__dshWhaleBongoDesktopChanged = sendSnapshot

function applySnapshot(snapshot) {
  if (!snapshot || !snapshot.cfg) return
  var nextCfg = snapshot.cfg
  try {
    var previous = JSON.parse(localStorage.getItem(STORE) || 'null')
    if (previous && previous.snap &&
        (previous.snap.ref === 'desktop-window' || previous.snap.ref === 'viewport') &&
        (!nextCfg.snap || nextCfg.snap.ref === 'card')) {
      nextCfg = Object.assign({}, nextCfg, { snap: previous.snap })
    }
  } catch {}
  snapshot = Object.assign({}, snapshot, { cfg: nextCfg })
  window.__DSH_WHALE_INITIAL_SNAPSHOT = snapshot
  if (snapshot.inputAnchor) window.__DSH_WHALE_DESKTOP_INPUT_ANCHOR = snapshot.inputAnchor
  window.__DSH_WHALE_DESKTOP_ENTER_TRANSITION = Boolean(snapshot.transitionToDesktop) && !snapshot.displayEnter
  window.__DSH_WHALE_DESKTOP_DISPLAY_ENTER = snapshot.displayEnter || null
  try {
    localStorage.setItem(STORE, JSON.stringify(nextCfg))
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
    try {
      const api = audioBeatApi()
      api?.setAudioBeatEnabled?.(audioBeatWanted)
      api?.setAudioBeatStatus?.(audioBeatStatus, audioBeatError, audioBeatBpm)
    } catch {}
    try { bridge.rendererMounted() } catch {}
  } catch (error) {
    try {
      bridge.sendConfig({ cfg: { error: String(error && error.message ? error.message : error) } })
    } catch {}
  }
}

function containsPoint(el, x, y) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

function forwardedTargetAt(x, y) {
  const root = document.getElementById('dsh-whale-bongo')
  if (root) {
    const button = root.querySelector('.dsnw-menu-btn')
    if (containsPoint(button, x, y) && getComputedStyle(button).visibility !== 'hidden') return button
    const menu = root.querySelector('.dsnw-menu')
    if (menu && menu.classList.contains('open') && containsPoint(menu, x, y)) {
      const nodes = Array.from(menu.querySelectorAll('button, select, input, [data-select], [role="option"], .dsnw-select'))
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (containsPoint(nodes[i], x, y)) return nodes[i]
      }
      return menu
    }
    const hitbox = root.querySelector('.dsnw-hitbox')
    if (containsPoint(hitbox, x, y)) return hitbox
  }
  return null
}

function emitPointer(target, type, x, y, buttons) {
  if (!target) return
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: buttons,
  }
  target.dispatchEvent(new PointerEvent(type, init))
}

function emitMouse(target, type, x, y) {
  if (!target) return
  target.dispatchEvent(new MouseEvent(type, {
    bubbles: type !== 'mouseenter' && type !== 'mouseleave',
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
  }))
}

function emitClick(target, x, y) {
  if (!target) return
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
  }))
}

let globalPointerDown = false
let globalPointerTarget = null
let globalPointerLast = null

function handleGlobalPointer(payload) {
  if (!payload) return
  const x = Number(payload.x)
  const y = Number(payload.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const target = forwardedTargetAt(x, y)
  if (!target) {
    if (globalPointerLast) {
      emitPointer(globalPointerLast, 'pointerleave', x, y, 0)
      emitMouse(globalPointerLast, 'mouseout', x, y)
      emitMouse(globalPointerLast, 'mouseleave', x, y)
    }
    globalPointerLast = null
    globalPointerDown = false
    globalPointerTarget = null
    return
  }
  if (globalPointerLast !== target) {
    if (globalPointerLast) {
      emitPointer(globalPointerLast, 'pointerleave', x, y, 0)
      emitMouse(globalPointerLast, 'mouseout', x, y)
      emitMouse(globalPointerLast, 'mouseleave', x, y)
    }
    emitMouse(target, 'mouseover', x, y)
    emitMouse(target, 'mouseenter', x, y)
  }
  if (payload.left) {
    if (!globalPointerDown) {
      globalPointerDown = true
      globalPointerTarget = target
      emitPointer(target, 'pointerdown', x, y, 1)
    }
    emitPointer(target, 'pointermove', x, y, 1)
  } else {
    if (globalPointerDown) {
      emitPointer(target, 'pointerup', x, y, 0)
      const downTarget = globalPointerTarget
      globalPointerDown = false
      globalPointerTarget = null
      if (downTarget && (downTarget === target || downTarget.contains?.(target) || target.contains?.(downTarget))) {
        emitClick(downTarget, x, y)
      }
    } else {
      emitPointer(target, 'pointermove', x, y, 0)
    }
  }
  globalPointerLast = target
}

bridge.onConfig(applySnapshot)
bridge.onBlur(() => {
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.closeMenu?.() } catch {}
})

bridge.onGlobalKeys(() => {
  window.__DSH_WHALE_GLOBAL_KEYS = true
})

bridge.onAudioBeat((payload) => {
  applyAudioBeatState(payload || {})
})

bridge.onMouseFollow((payload) => {
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.setMouseFollow?.(payload) } catch {}
})

bridge.onPointer(handleGlobalPointer)

bridge.onInputAnchor((anchor) => {
  window.__DSH_WHALE_DESKTOP_INPUT_ANCHOR = anchor || null
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.setDesktopInputAnchor?.(anchor || null) } catch {}
})

bridge.onWindows((list) => {
  window.__DSH_WHALE_DESKTOP_WINDOWS = Array.isArray(list) ? list : []
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.setDesktopWindows?.(window.__DSH_WHALE_DESKTOP_WINDOWS) } catch {}
})

bridge.onDisplay((info) => {
  window.__DSH_WHALE_DESKTOP_DISPLAY = info || null
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.setDesktopDisplay?.(info || null) } catch {}
})

bridge.onDisplaySwitch((payload) => {
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.setDesktopDisplaySwitch?.(payload || null) } catch {}
})

bridge.onRecall(() => {
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.recall?.() } catch {}
})

bridge.onReturnClient(() => {
  const api = window.__dshWhaleBongoDesktopInput
  try { api?.returnToClient?.() } catch {}
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
  try { audioBeatDetector?.stop?.() } catch {}
  try {
    window.__dshWhaleBongoDesktopDispose?.()
  } catch {}
})

bridge.ready()
