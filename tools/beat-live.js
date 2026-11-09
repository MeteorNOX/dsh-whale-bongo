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
}
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

function setConnection(kind, title, detail) {
  els.connection.className = 'connection ' + (kind || '')
  els.connTitle.textContent = title
  els.connDetail.textContent = detail
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

function flashBeat() {
  els.beatVisual.classList.add('hit')
  clearTimeout(hitTimer)
  hitTimer = setTimeout(() => els.beatVisual.classList.remove('hit'), 130)
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

window.addEventListener('resize', draw)
connect()
pollInfo()
setInterval(() => { if (!paused) draw() }, 250)
