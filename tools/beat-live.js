'use strict'

const $ = (id) => document.getElementById(id)
const els = {
  connection: $('connection'), connTitle: $('connTitle'), connDetail: $('connDetail'),
  bpm: $('bpm'), confidence: $('confidence'), statePill: $('statePill'), statusText: $('statusText'),
  countdown: $('countdown'), beatProgress: $('beatProgress'), beatHint: $('beatHint'),
  beatVisual: $('beatVisual'), energy: $('energy'), energyBar: $('energyBar'),
  audioState: $('audioState'), suppressText: $('suppressText'),
  period: $('period'), beatCount: $('beatCount'), analysisCount: $('analysisCount'),
  analysisMs: $('analysisMs'), analysisEvery: $('analysisEvery'), buffer: $('buffer'),
  gridAge: $('gridAge'), lead: $('lead'), candidate: $('candidate'), candidateHits: $('candidateHits'),
  pid: $('pid'), bridge: $('bridge'), analysisRows: $('analysisRows'), events: $('events'),
  recorder: $('recorder'), recordState: $('recordState'), recordToggle: $('recordToggle'),
  recordExport: $('recordExport'), recDot: $('recDot'),
  stageGrid: $('stageGrid'), stageSelected: $('stageSelected'), stageDemo: $('stageDemo'),
}
const RECORD_FORMAT = 'dsh-whale-bongo-beat-recording'
const RECORD_VERSION = 1
const MAX_RECORD_MS = 15 * 60 * 1000
let stream = null
let paused = false
let lastSample = null
let lastBeatCount = 0
let lastAnalysisCount = 0
let lastState = ''
let history = []
let beatMarks = []
let hitTimer = 0
let infoTimer = 0
let recorder = null
let recordStartedPerf = 0
let recordStartedWall = 0
let recordTicker = 0
const STAGE_KEY = 'dsh-whale-bongo:stage-effect'
const STAGE_LABELS = {
  aura: '呼吸光环',
  ripple: '同心波纹',
  bars: '低频音柱',
  orbit: '轨道微光',
  wave: '声浪地平线',
  spot: '舞台追光',
}
let stageFlashTimer = 0
let lastLiveStageBeat = 0

function recordElapsed() {
  return Math.max(0, Math.round(performance.now() - recordStartedPerf))
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
}

function recordLog(kind, text) {
  if (!recorder || !recorder.active) return
  recorder.logs.push({
    t: recordElapsed(),
    at: new Date().toISOString(),
    kind: kind || '',
    text: String(text || ''),
  })
}

function updateRecordUi() {
  if (!els.recorder || !els.recordState) return
  const active = Boolean(recorder && recorder.active)
  els.recorder.classList.toggle('active', active)
  els.recordToggle.classList.toggle('stop', active)
  els.recordToggle.textContent = active ? '停止录制' : '开始录制'
  els.recordToggle.disabled = false
  if (active) {
    els.recordState.textContent = '录制中 ' + fmtDuration(recordElapsed()) + ' · ' + recorder.samples.length + ' 帧'
  } else if (recorder) {
    els.recordState.textContent = '已录制 ' + fmtDuration(recorder.durationMs) + ' · ' + recorder.samples.length + ' 帧'
  } else {
    els.recordState.textContent = '未录制'
  }
  els.recordExport.disabled = !recorder || active || recorder.samples.length === 0
}

function startRecording() {
  if (recorder && recorder.active) return
  recordStartedPerf = performance.now()
  recordStartedWall = Date.now()
  const selectedStage = document.querySelector('.stage-card.is-selected')
  recorder = {
    format: RECORD_FORMAT,
    version: RECORD_VERSION,
    startedAt: new Date(recordStartedWall).toISOString(),
    startedAtMs: recordStartedWall,
    endedAt: null,
    endedAtMs: 0,
    durationMs: 0,
    stopReason: '',
    active: true,
    bridge: null,
    plugin: null,
    environment: {
      href: location.href,
      userAgent: navigator.userAgent,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      devicePixelRatio: window.devicePixelRatio || 1,
      viewport: { width: innerWidth, height: innerHeight },
      stageEffect: selectedStage ? selectedStage.getAttribute('data-stage') : '',
    },
    samples: [],
    beats: [],
    analyses: [],
    statusChanges: [],
    logs: [],
  }
  els.recorder.classList.add('active')
  updateRecordUi()
  recordTicker = setInterval(updateRecordUi, 250)
  logEvent('warn', '开始录制 · 请保持音乐播放，停止后导出 JSON')
  fetch('/api/info', { cache: 'no-store' }).then((response) => response.json()).then((info) => {
    if (!recorder) return
    recorder.bridge = info && info.bridge ? info.bridge : null
    recorder.plugin = info && info.state ? info.state : null
  }).catch(() => {})
}

function stopRecording(reason) {
  if (!recorder || !recorder.active) return
  const elapsed = recordElapsed()
  recorder.durationMs = elapsed
  recorder.endedAtMs = recordStartedWall + elapsed
  recorder.endedAt = new Date(recorder.endedAtMs).toISOString()
  recorder.stopReason = reason || 'manual'
  recordLog('record', '录制停止 · ' + fmtDuration(elapsed) + ' · ' + recorder.samples.length + ' 帧')
  recorder.active = false
  clearInterval(recordTicker)
  recordTicker = 0
  updateRecordUi()
  logEvent('warn', '录制已停止 · ' + fmtDuration(elapsed) + ' · ' + recorder.samples.length + ' 帧')
}

function recordTelemetry(sample, flags) {
  if (!recorder || !recorder.active) return
  const t = recordElapsed()
  const receivedAt = new Date().toISOString()
  const copy = {
    t,
    receivedAt,
    at: sample.at || 0,
    state: sample.state || 'stopped',
    error: sample.error || '',
    enabled: Boolean(sample.enabled),
    bpm: Number(sample.bpm) || 0,
    confidence: Number(sample.confidence) || 0,
    beatPeriod: Number(sample.beatPeriod) || 0,
    beatCount: Number(sample.beatCount) || 0,
    analysisCount: Number(sample.analysisCount) || 0,
    analysisMs: Number(sample.analysisMs) || 0,
    analysisEveryMs: Number(sample.analysisEveryMs) || 0,
    windowSeconds: Number(sample.windowSeconds) || 0,
    sampleRate: Number(sample.sampleRate) || 0,
    bufferSeconds: Number(sample.bufferSeconds) || 0,
    audioTime: Number(sample.audioTime) || 0,
    nextBeatAt: Number(sample.nextBeatAt) || 0,
    nextBeatIn: Number(sample.nextBeatIn) || 0,
    leadMs: Number(sample.leadMs) || 0,
    energy: Number(sample.energy) || 0,
    audible: Boolean(sample.audible),
    suppressed: Boolean(sample.suppressed),
    suppressLeftMs: Number(sample.suppressLeftMs) || 0,
    gridAgeMs: Number(sample.gridAgeMs) || 0,
    candidateBpm: Number(sample.candidateBpm) || 0,
    candidateHits: Number(sample.candidateHits) || 0,
    last: sample.last || null,
  }
  recorder.samples.push(copy)
  if (flags.beat) {
    recorder.beats.push({
      t,
      at: copy.at,
      bpm: copy.bpm,
      confidence: copy.confidence,
      energy: copy.energy,
      candidateBpm: copy.candidateBpm,
      beatCount: copy.beatCount,
      nextBeatIn: copy.nextBeatIn,
    })
  }
  if (flags.analysis) {
    recorder.analyses.push({
      t,
      at: copy.at,
      analysisCount: copy.analysisCount,
      state: copy.state,
      bpm: copy.last ? copy.last.bpm : copy.bpm,
      confidence: copy.last ? copy.last.confidence : copy.confidence,
      ms: copy.last ? copy.last.ms : copy.analysisMs,
      duration: copy.last ? copy.last.duration : 0,
      beats: copy.last ? copy.last.beats : [],
    })
  }
  if (flags.status) {
    recorder.statusChanges.push({ t, at: copy.at, state: copy.state, error: copy.error, bpm: copy.bpm })
  }
  if (t >= MAX_RECORD_MS) stopRecording('max-duration')
}

function exportRecording() {
  if (!recorder || recorder.active || !recorder.samples.length) return
  const payload = JSON.parse(JSON.stringify(recorder))
  payload.active = false
  payload.exportedAt = new Date().toISOString()
  payload.exportedAtMs = Date.now()
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = new Date(payload.startedAtMs).toISOString().replace(/[:.]/g, '-')
  link.href = url
  link.download = 'whale-beat-recording-' + stamp + '.json'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  logEvent('', '已导出录制 · ' + payload.samples.length + ' 帧')
}

function setConnection(kind, title, detail) {
  const changed = els.connTitle.textContent !== title || els.connDetail.textContent !== detail
  els.connection.className = 'connection ' + (kind || '')
  els.connTitle.textContent = title
  els.connDetail.textContent = detail
  if (changed && recorder && recorder.active && title) {
    recordLog('connection', title + ' · ' + detail)
  }
}

function fmt(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return '--'
  return Number(value).toFixed(digits)
}

function stateLabel(state) {
  return ({ active: '运行中', starting: '启动中', stopped: '已停止', error: '错误' })[state] || (state || '未知')
}

function logEvent(kind, text) {
  if (!els.events) return
  recordLog(kind, text)
  const empty = els.events.querySelector('.empty')
  if (empty) empty.remove()
  const row = document.createElement('div')
  row.className = 'event ' + kind
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  row.innerHTML = '<b>' + time + '</b><span></span>'
  row.querySelector('span').textContent = text
  els.events.prepend(row)
  while (els.events.children.length > 30) els.events.lastChild.remove()
}

function addAnalysis(sample) {
  if (!sample || !sample.last) return
  const empty = els.analysisRows.querySelector('.empty')
  if (empty) empty.remove()
  const last = sample.last
  const row = document.createElement('tr')
  row.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td></td>'
  const cells = row.children
  cells[0].textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  cells[1].textContent = fmt(last.bpm, 1)
  cells[2].textContent = fmt(last.confidence * 100, 0) + '%'
  cells[3].textContent = fmt(last.ms, 1) + ' ms'
  cells[4].textContent = String(last.beats ? last.beats.length : 0)
  cells[5].textContent = stateLabel(sample.state)
  els.analysisRows.prepend(row)
  while (els.analysisRows.children.length > 16) els.analysisRows.lastChild.remove()
}

function applyTelemetry(env) {
  if (paused) return
  const sample = env && env.telemetry
  if (env) {
    if (env.port) els.bridge.textContent = 'bridge 127.0.0.1:' + env.port
    if (env.pid) els.pid.textContent = 'PID ' + env.pid
  }
  if (!sample) {
    els.bpm.textContent = '--'
    els.statusText.textContent = '已连接 helper，但还没有收到律动数据'
    return
  }
  lastSample = sample
  const state = sample.state || 'stopped'
  const beatChanged = Number(sample.beatCount || 0) > lastBeatCount
  const analysisChanged = Number(sample.analysisCount || 0) > lastAnalysisCount
  const statusChanged = state !== lastState
  if (recorder && recorder.active) {
    recordTelemetry(sample, { beat: beatChanged, analysis: analysisChanged, status: statusChanged })
  }
  els.bpm.textContent = sample.bpm ? fmt(sample.bpm, 1) : '--'
  els.confidence.textContent = fmt((sample.confidence || 0) * 100, 0) + '%'
  els.statePill.textContent = stateLabel(state)
  els.statePill.classList.toggle('active', state === 'active')
  els.statusText.textContent = sample.error || (
    state === 'active' ? '正在读取插件节拍网格' :
    state === 'starting' ? '正在申请系统音频…' :
    state === 'stopped' ? '律动已停止' : '等待数据'
  )
  els.countdown.textContent = Number.isFinite(sample.nextBeatIn) && sample.nextBeatIn > 0
    ? fmt(sample.nextBeatIn * 1000, 0) : '--'
  const period = Number(sample.beatPeriod) || 0
  const progress = period > 0
    ? Math.max(0, Math.min(1, 1 - Math.max(0, sample.nextBeatIn || 0) / period)) : 0
  els.beatProgress.style.width = (progress * 100).toFixed(1) + '%'
  els.beatHint.textContent = sample.audible ? (sample.suppressed ? '插件正在屏蔽自身按键声' : '系统音频有声音') : '等待系统音频'
  els.energy.textContent = Number(sample.energy || 0).toFixed(4)
  const energyLevel = Math.max(0, Math.min(1, Math.sqrt(Number(sample.energy) || 0) * 5))
  els.energyBar.style.width = (energyLevel * 100).toFixed(1) + '%'
  els.audioState.textContent = sample.audible ? '有声' : '静音'
  els.suppressText.textContent = sample.suppressed ? '屏蔽 ' + fmt(sample.suppressLeftMs, 0) + 'ms' : '未屏蔽'
  els.period.textContent = period ? fmt(period * 1000, 0) + ' ms' : '--'
  els.beatCount.textContent = String(sample.beatCount || 0)
  els.analysisCount.textContent = String(sample.analysisCount || 0)
  els.analysisMs.textContent = sample.analysisMs ? fmt(sample.analysisMs, 1) + ' ms' : '--'
  els.analysisEvery.textContent = sample.analysisEveryMs ? fmt(sample.analysisEveryMs, 0) + ' ms' : '--'
  els.buffer.textContent = sample.bufferSeconds ? fmt(sample.bufferSeconds, 2) + ' / ' + fmt(sample.windowSeconds, 0) + 's' : '--'
  els.gridAge.textContent = sample.gridAgeMs ? fmt(sample.gridAgeMs, 0) + ' ms' : '--'
  els.lead.textContent = Number(sample.leadMs || 0) === 0 ? '0 ms' : (sample.leadMs > 0 ? '提前 ' : '延后 ') + fmt(Math.abs(sample.leadMs), 0) + ' ms'
  els.candidate.textContent = sample.candidateBpm ? fmt(sample.candidateBpm, 1) : '--'
  els.candidateHits.textContent = (sample.candidateHits || 0) + ' 次确认'

  const at = Date.now()
  history.push({ at, value: Number(sample.energy) || 0 })
  while (history.length && at - history[0].at > 12000) history.shift()

  if ((sample.beatCount || 0) > lastBeatCount) {
    beatMarks.push(at)
    while (beatMarks.length && at - beatMarks[0] > 12000) beatMarks.shift()
    flashBeat()
    logEvent('beat', '拍点 · ' + fmt(sample.bpm, 1) + ' BPM · 强度 ' + fmt(sample.confidence * 100, 0) + '%')
  }
  lastBeatCount = sample.beatCount || 0

  if ((sample.analysisCount || 0) > lastAnalysisCount && sample.analysisCount > 0) {
    addAnalysis(sample)
    logEvent('', '分析 #' + sample.analysisCount + ' · ' + fmt(sample.last && sample.last.bpm, 1) + ' BPM · ' + fmt(sample.analysisMs, 1) + ' ms')
  }
  lastAnalysisCount = sample.analysisCount || 0

  if (state !== lastState) {
    if (lastState) logEvent(state === 'error' ? 'warn' : '', '状态：' + stateLabel(lastState) + ' → ' + stateLabel(state))
    lastState = state
  }
  draw()
}

function selectStage(card, persist) {
  if (!card || !els.stageGrid) return
  const cards = els.stageGrid.querySelectorAll('.stage-card')
  for (const item of cards) {
    const on = item === card
    item.classList.toggle('is-selected', on)
    item.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
  const key = card.getAttribute('data-stage') || 'aura'
  if (els.stageSelected) els.stageSelected.textContent = '已选择 · ' + (STAGE_LABELS[key] || key)
  if (persist) {
    try { localStorage.setItem(STAGE_KEY, key) } catch {}
  }
}

function restoreStage() {
  if (!els.stageGrid) return
  let key = 'aura'
  try { key = localStorage.getItem(STAGE_KEY) || 'aura' } catch {}
  const card = els.stageGrid.querySelector('.stage-card[data-stage="' + key + '"]') ||
    els.stageGrid.querySelector('.stage-card')
  selectStage(card, false)
}

function flashStages() {
  if (!els.stageGrid) return
  const visuals = els.stageGrid.querySelectorAll('.stage-visual')
  for (const visual of visuals) {
    visual.classList.remove('is-beat')
    void visual.offsetWidth
    visual.classList.add('is-beat')
  }
  clearTimeout(stageFlashTimer)
  stageFlashTimer = setTimeout(() => {
    for (const visual of visuals) visual.classList.remove('is-beat')
  }, 900)
}

function flashBeat() {
  els.beatVisual.classList.add('hit')
  clearTimeout(hitTimer)
  hitTimer = setTimeout(() => els.beatVisual.classList.remove('hit'), 130)
  lastLiveStageBeat = Date.now()
  flashStages()
}

function resizeCanvas() {
  const canvas = $('wave')
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(320, Math.floor(rect.width))
  const height = Math.max(180, Math.floor(rect.height))
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }
  return { canvas, width, height, dpr }
}

function draw() {
  const { canvas, width, height, dpr } = resizeCanvas()
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const now = Date.now()
  const left = 14
  const right = width - 14
  const top = 12
  const bottom = height - 16

  ctx.strokeStyle = 'rgba(138,190,210,.10)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = top + (bottom - top) * (i / 4)
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke()
  }
  for (const mark of beatMarks) {
    const x = right - ((now - mark) / 12000) * (right - left)
    if (x < left) continue
    ctx.strokeStyle = 'rgba(255,125,168,.35)'
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke()
  }
  if (history.length < 2) {
    ctx.fillStyle = 'rgba(127,154,165,.8)'
    ctx.font = '12px "Cascadia Code", Consolas, monospace'
    ctx.fillText('等待插件推送能量数据…', left + 8, top + 26)
    return
  }
  ctx.beginPath()
  let first = true
  for (const point of history) {
    const x = right - ((now - point.at) / 12000) * (right - left)
    const value = Math.min(1, Math.sqrt(Math.max(0, point.value)) * 5)
    const y = bottom - value * (bottom - top)
    if (first) { ctx.moveTo(x, y); first = false } else ctx.lineTo(x, y)
  }
  const gradient = ctx.createLinearGradient(0, top, 0, bottom)
  gradient.addColorStop(0, 'rgba(85,228,212,.9)')
  gradient.addColorStop(1, 'rgba(119,167,255,.12)')
  ctx.strokeStyle = gradient
  ctx.lineWidth = 1.8
  ctx.stroke()
  ctx.lineTo(right, bottom)
  ctx.lineTo(left, bottom)
  ctx.closePath()
  ctx.fillStyle = 'rgba(85,228,212,.07)'
  ctx.fill()
}

async function pollInfo() {
  clearTimeout(infoTimer)
  try {
    const response = await fetch('/api/info', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) {
      setConnection('bad', '未连接插件', data.error || 'helper 未运行')
    } else if (data.sample && !lastSample) {
      setConnection('ok', '已连接插件', '等待实时事件…')
    }
  } catch (error) {
    setConnection('bad', '工具服务异常', String(error && error.message || error))
  }
  infoTimer = setTimeout(pollInfo, 3000)
}

function connect() {
  if (stream) stream.close()
  setConnection('', '连接中', '订阅插件实时数据…')
  stream = new EventSource('./api/stream')
  stream.addEventListener('telemetry', (event) => {
    setConnection('ok', '插件已连接', '实时数据流')
    try {
      const envelope = JSON.parse(event.data)
      if (envelope && envelope.port) els.bridge.textContent = 'bridge 127.0.0.1:' + envelope.port
      if (envelope && envelope.pid) els.pid.textContent = 'PID ' + envelope.pid
      applyTelemetry(envelope)
    } catch {}
  })
  stream.onopen = () => setConnection('ok', '插件已连接', '实时数据流')
  stream.onerror = () => {
    setConnection('bad', '连接中断', '等待 helper / 自动重连')
    // EventSource reconnects by itself; polling keeps the reason visible.
  }
}

$('clear').addEventListener('click', () => {
  history = []
  beatMarks = []
  els.events.innerHTML = '<div class="empty">等待事件…</div>'
  els.analysisRows.innerHTML = '<tr><td colspan="6" class="empty">等待第一次分析…</td></tr>'
  lastAnalysisCount = lastSample ? lastSample.analysisCount : 0
  draw()
})

$('recordToggle').addEventListener('click', () => {
  if (recorder && recorder.active) stopRecording('manual')
  else startRecording()
})
$('recordExport').addEventListener('click', exportRecording)
window.addEventListener('beforeunload', (event) => {
  if (!recorder || !recorder.active) return
  event.preventDefault()
  event.returnValue = ''
})
window.addEventListener('resize', draw)
window.__BeatLiveRecorder = {
  start: startRecording,
  stop: stopRecording,
  export: exportRecording,
  get: () => recorder,
}
window.__BeatLiveStage = {
  select: (key) => {
    if (!els.stageGrid) return
    selectStage(els.stageGrid.querySelector('.stage-card[data-stage="' + key + '"]'), true)
  },
  flash: flashStages,
  current: () => {
    const card = els.stageGrid && els.stageGrid.querySelector('.stage-card.is-selected')
    return card ? card.getAttribute('data-stage') : null
  },
}
if (els.stageGrid) {
  els.stageGrid.addEventListener('click', (event) => {
    const card = event.target.closest('.stage-card')
    if (card) selectStage(card, true)
  })
  restoreStage()
}
if (els.stageDemo) els.stageDemo.addEventListener('click', flashStages)
setInterval(() => {
  if (document.hidden) return
  if (Date.now() - lastLiveStageBeat > 1600) flashStages()
}, 520)
updateRecordUi()
connect()
pollInfo()
setInterval(() => { if (!paused) draw() }, 250)
