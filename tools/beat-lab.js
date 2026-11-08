(function () {
  'use strict'

  var detector = globalThis.WhaleBeat
  var $ = function (id) { return document.getElementById(id) }

  var ctx = null
  var stream = null
  var source = null
  var processor = null
  var sink = null
  var running = false
  var sourceName = '无输入'
  var analyzeTimer = 0
  var analysisNo = 0
  var ring = null
  var ringWrite = 0
  var ringFilled = 0
  var sampleRate = 48000
  var maxRingSeconds = 12

  var lastAnalyzed = null
  var lastBeats = []
  var lastBpm = 0
  var fileSamples = null
  var fileSampleRate = 0

  function setStatus(text, kind) {
    var el = $('status')
    el.textContent = text
    el.className = 'status' + (kind ? ' ' + kind : '')
  }

  function fmt(value, digits) {
    if (!isFinite(value)) return '--'
    return Number(value).toFixed(digits == null ? 1 : digits)
  }

  function windowSeconds() {
    return Number($('windowSeconds').value) || 8
  }

  function expectedBpm() {
    return Number($('expectedBpm').value) || 0
  }

  function ensureContext() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext
      if (!AC) throw new Error('当前浏览器不支持 Web Audio')
      ctx = new AC({ latencyHint: 'interactive' })
      sampleRate = ctx.sampleRate
      ring = new Float32Array(Math.ceil(sampleRate * maxRingSeconds))
      ringWrite = 0
      ringFilled = 0
    }
    return ctx
  }

  function ensureRing() {
    if (!ring) {
      ring = new Float32Array(Math.ceil(sampleRate * maxRingSeconds))
      ringWrite = 0
      ringFilled = 0
    }
  }

  function pushSamples(input) {
    if (!input || !input.length) return
    ensureRing()
    for (var i = 0; i < input.length; i++) {
      ring[ringWrite] = input[i]
      ringWrite = (ringWrite + 1) % ring.length
      if (ringFilled < ring.length) ringFilled++
    }
  }

  function readLast(seconds) {
    if (!ring || !ringFilled) return new Float32Array(0)
    var count = Math.min(ringFilled, Math.floor(sampleRate * seconds))
    var out = new Float32Array(count)
    var start = (ringWrite - count + ring.length) % ring.length
    var first = Math.min(count, ring.length - start)
    out.set(ring.subarray(start, start + first), 0)
    if (first < count) out.set(ring.subarray(0, count - first), first)
    return out
  }

  function sourceSamples() {
    if (fileSamples) {
      var count = Math.min(fileSamples.length, Math.floor(fileSampleRate * windowSeconds()))
      return fileSamples.subarray(0, count)
    }
    return readLast(windowSeconds())
  }

  function currentRate() {
    return fileSamples ? fileSampleRate : sampleRate
  }

  function updateCards(result, computeMs, totalMs, duration) {
    var bpm = result && result.bpm ? result.bpm : 0
    var confidence = result && isFinite(result.confidence) ? result.confidence : 0
    var beats = result && result.beats ? result.beats.length : 0
    lastBpm = bpm
    $('bpm').textContent = bpm ? fmt(bpm, 1) : '--'
    $('bpmSub').textContent = bpm ? '节拍网格' : '未检测到稳定节拍'
    $('confidence').textContent = result ? fmt(confidence, 2) : '--'
    $('compute').textContent = computeMs == null ? '--' : fmt(computeMs, 2) + ' ms'
    $('computeSub').textContent = totalMs == null ? 'detect() 同步调用' : 'detect / 总计 ' + fmt(totalMs, 2) + ' ms'
    $('window').textContent = duration == null ? '--' : fmt(duration, 2) + ' s'
    $('windowSub').textContent = result ? '实际送入 ' + Math.round((result.beats && result.beats.length) || 0) + ' 个网格点' : '尚未分析'
    $('beats').textContent = result ? String(beats) : '--'
    $('beatSub').textContent = bpm ? '间隔约 ' + fmt(60 / bpm, 3) + ' s' : '网格点'
    var expected = expectedBpm()
    if (result && bpm && expected > 0) {
      var error = Math.abs(bpm - expected)
      $('error').textContent = fmt(error, 1) + ' BPM'
      $('errorSub').textContent = fmt((error / expected) * 100, 1) + '% · 参考 ' + expected
      $('error').style.color = error <= 2 ? 'var(--good)' : error <= 5 ? 'var(--accent-2)' : 'var(--bad)'
    } else {
      $('error').textContent = '--'
      $('errorSub').textContent = expected > 0 ? '参考 ' + expected : '未设置参考'
      $('error').style.color = ''
    }
  }

  function addRow(result, computeMs, totalMs, duration) {
    var tbody = $('rows')
    var empty = tbody.querySelector('.empty')
    if (empty) {
      var emptyRow = empty.closest('tr')
      if (emptyRow) emptyRow.parentNode.removeChild(emptyRow)
    }
    var tr = document.createElement('tr')
    var expected = expectedBpm()
    var bpm = result && result.bpm ? result.bpm : 0
    var error = result && bpm && expected > 0 ? Math.abs(bpm - expected) : null
    var cells = [
      String(++analysisNo),
      new Date().toLocaleTimeString(),
      sourceName,
      fmt(duration, 2) + ' s',
      fmt(computeMs, 2) + ' / ' + fmt(totalMs, 2) + ' ms',
      bpm ? fmt(bpm, 1) : '--',
      result ? fmt(result.confidence || 0, 2) : '--',
      result && result.beats ? String(result.beats.length) : '--',
      error == null ? '--' : fmt(error, 1) + ' BPM',
    ]
    for (var i = 0; i < cells.length; i++) {
      var td = document.createElement('td')
      td.textContent = cells[i]
      tr.appendChild(td)
    }
    tbody.insertBefore(tr, tbody.firstChild)
    while (tbody.children.length > 30) tbody.removeChild(tbody.lastChild)
  }

  function analyze(samples, label) {
    if (!detector || !detector.detect) {
      setStatus('节拍检测器未加载：检查 vendor/beat-detect.js', 'err')
      return
    }
    if (!samples || !samples.length) {
      setStatus('缓冲区还没有音频。', 'err')
      return
    }
    var rate = currentRate()
    if (!rate) return
    if (samples.length < rate * 1.2) {
      setStatus('至少需要约 1.2 秒音频，当前 ' + fmt(samples.length / rate, 2) + ' 秒。', 'err')
      return
    }
    sourceName = label || sourceName
    $('sourceLabel').textContent = sourceName + ' · ' + fmt(samples.length / rate, 2) + ' 秒'
    var copy = Float32Array.from(samples)
    var totalStart = performance.now()
    var start = performance.now()
    var result
    try {
      result = detector.detect(copy, { fs: rate, minBpm: 60, maxBpm: 180 })
    } catch (error) {
      setStatus('检测失败：' + (error && error.message ? error.message : String(error)), 'err')
      return
    }
    var computeMs = performance.now() - start
    var totalMs = performance.now() - totalStart
    lastAnalyzed = copy
    lastBeats = result && result.beats ? result.beats.slice() : []
    updateCards(result, computeMs, totalMs, copy.length / rate)
    addRow(result, computeMs, totalMs, copy.length / rate)
    draw()
    setStatus('分析完成：' + (result.bpm ? fmt(result.bpm, 1) + ' BPM' : '未检测到稳定节拍') +
      ' · detect ' + fmt(computeMs, 2) + ' ms', result.bpm ? 'ok' : '')
  }

  function draw() {
    var canvas = $('wave')
    var dpr = window.devicePixelRatio || 1
    var width = Math.max(320, canvas.clientWidth || 1200)
    var height = Math.max(160, canvas.clientHeight || 260)
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    var g = canvas.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    g.fillStyle = '#0b1017'
    g.fillRect(0, 0, width, height)
    g.strokeStyle = '#1e2a38'
    g.lineWidth = 1
    for (var i = 1; i < 8; i++) {
      var x = (width * i) / 8
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke()
    }
    g.strokeStyle = '#26384c'
    g.beginPath(); g.moveTo(0, height / 2); g.lineTo(width, height / 2); g.stroke()

    var samples = lastAnalyzed || sourceSamples()
    if (!samples || !samples.length) {
      g.fillStyle = '#65717e'
      g.font = '13px "Microsoft YaHei", sans-serif'
      g.fillText('等待音频输入…', 18, 28)
      return
    }

    var step = Math.max(1, Math.floor(samples.length / width))
    g.strokeStyle = '#4cc2ff'
    g.lineWidth = 1.3
    g.beginPath()
    for (var px = 0; px < width; px++) {
      var start = px * step
      var end = Math.min(samples.length, start + step)
      var min = 1, max = -1
      for (var j = start; j < end; j++) {
        var v = samples[j]
        if (v < min) min = v
        if (v > max) max = v
      }
      if (start >= samples.length) break
      var y1 = height / 2 - max * (height * 0.43)
      var y2 = height / 2 - min * (height * 0.43)
      g.moveTo(px + 0.5, y1)
      g.lineTo(px + 0.5, Math.max(y2, y1 + 0.7))
    }
    g.stroke()

    var duration = samples.length / currentRate()
    if (lastBeats.length && duration) {
      g.strokeStyle = 'rgba(255,207,92,.9)'
      g.lineWidth = 1.5
      for (var b = 0; b < lastBeats.length; b++) {
        var beat = Number(lastBeats[b])
        if (!isFinite(beat) || beat < 0 || beat > duration) continue
        var bx = (beat / duration) * width
        g.beginPath(); g.moveTo(bx, 0); g.lineTo(bx, height); g.stroke()
      }
    }
  }

  function stopCapture(clearStatus) {
    if (analyzeTimer) {
      clearInterval(analyzeTimer)
      analyzeTimer = 0
    }
    running = false
    $('stopBtn').disabled = true
    $('analyzeBtn').disabled = !fileSamples
    if (processor) {
      try { processor.disconnect() } catch (e) {}
      processor.onaudioprocess = null
      processor = null
    }
    if (sink) {
      try { sink.disconnect() } catch (e) {}
      sink = null
    }
    if (source) {
      try { source.disconnect() } catch (e) {}
      source = null
    }
    if (stream) {
      try {
        var tracks = stream.getTracks()
        for (var i = 0; i < tracks.length; i++) tracks[i].stop()
      } catch (e) {}
      stream = null
    }
    if (ctx) {
      try { ctx.close() } catch (e) {}
      ctx = null
    }
    ring = null
    ringWrite = 0
    ringFilled = 0
    if (clearStatus !== false) setStatus('采集已停止。')
    draw()
  }

  function startTimer() {
    if (analyzeTimer) clearInterval(analyzeTimer)
    var interval = Number($('intervalMs').value) || 1800
    analyzeTimer = setInterval(function () {
      if (!running) return
      var samples = readLast(windowSeconds())
      if (samples.length >= sampleRate * 1.2) analyze(samples, sourceName)
    }, interval)
  }

  async function startCapture(kind) {
    stopCapture(false)
    try {
      ensureContext()
      if (ctx.state === 'suspended') await ctx.resume()
      if (kind === 'system') {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          throw new Error('浏览器不支持系统音频采集，请用 Chrome/Edge 并允许屏幕共享音频')
        }
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        sourceName = '系统声音'
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        })
        sourceName = '麦克风'
      }
      var audioTracks = stream.getAudioTracks()
      if (!audioTracks.length) throw new Error('没有音频轨道；系统声音采集时请勾选“分享音频”')
      var videoTracks = stream.getVideoTracks()
      for (var i = 0; i < videoTracks.length; i++) videoTracks[i].stop()
      source = ctx.createMediaStreamSource(new MediaStream(audioTracks))
      processor = ctx.createScriptProcessor(4096, 1, 1)
      sink = ctx.createGain()
      sink.gain.value = 0
      processor.onaudioprocess = function (event) {
        if (running) pushSamples(event.inputBuffer.getChannelData(0))
      }
      source.connect(processor)
      processor.connect(sink)
      sink.connect(ctx.destination)
      running = true
      $('stopBtn').disabled = false
      $('analyzeBtn').disabled = false
      setStatus('正在监听' + sourceName + '。第一次分析需要约 2.4 秒缓冲。', 'ok')
      startTimer()
    } catch (error) {
      stopCapture(false)
      setStatus('启动失败：' + (error && error.message ? error.message : String(error)), 'err')
    }
  }

  function clickTrack(fs) {
    var seconds = 12
    var bpm = 120
    var data = new Float32Array(Math.round(fs * seconds))
    var period = 60 / bpm
    for (var beat = 0; beat < seconds / period; beat++) {
      var start = Math.round(beat * period * fs)
      for (var i = 0; i < Math.min(1600, data.length - start); i++) {
        var t = i / fs
        data[start + i] += Math.sin(2 * Math.PI * 80 * t) * Math.exp(-t * 26) * 0.9
      }
    }
    return data
  }

  function analyzeClick() {
    stopCapture(false)
    ensureContext()
    sampleRate = 48000
    fileSamples = null
    fileSampleRate = 0
    sourceName = '测试点击 120 BPM'
    var samples = clickTrack(sampleRate)
    lastAnalyzed = samples
    lastBeats = []
    $('expectedBpm').value = '120'
    analyze(samples.subarray(0, Math.floor(sampleRate * windowSeconds())), sourceName)
    $('analyzeBtn').disabled = false
  }

  function readFile(file) {
    if (!file) return
    stopCapture(false)
    ensureContext()
    var reader = new FileReader()
    reader.onload = async function () {
      try {
        var buffer = await ctx.decodeAudioData(reader.result)
        fileSampleRate = buffer.sampleRate
        var channels = buffer.numberOfChannels
        var length = buffer.length
        var mono = new Float32Array(length)
        for (var ch = 0; ch < channels; ch++) {
          var data = buffer.getChannelData(ch)
          for (var i = 0; i < length; i++) mono[i] += data[i] / channels
        }
        fileSamples = mono
        sourceName = '文件：' + file.name
        $('sourceLabel').textContent = sourceName + ' · ' + fmt(length / fileSampleRate, 2) + ' 秒'
        $('analyzeBtn').disabled = false
        lastAnalyzed = null
        lastBeats = []
        setStatus('已载入 ' + file.name + '（' + fmt(length / fileSampleRate, 2) + ' 秒），点击“立即分析”。', 'ok')
        draw()
      } catch (error) {
        setStatus('音频解码失败：' + (error && error.message ? error.message : String(error)), 'err')
      }
    }
    reader.onerror = function () { setStatus('文件读取失败。', 'err') }
    reader.readAsArrayBuffer(file)
  }

  $('systemBtn').addEventListener('click', function () { startCapture('system') })
  $('micBtn').addEventListener('click', function () { startCapture('mic') })
  $('stopBtn').addEventListener('click', function () { stopCapture(true) })
  $('analyzeBtn').addEventListener('click', function () {
    if (fileSamples) analyze(sourceSamples(), sourceName)
    else if (running) analyze(readLast(windowSeconds()), sourceName)
    else setStatus('没有可分析的音频。', 'err')
  })
  $('clearBtn').addEventListener('click', function () {
    stopCapture(false)
    fileSamples = null
    fileSampleRate = 0
    lastAnalyzed = null
    lastBeats = []
    lastBpm = 0
    analysisNo = 0
    sourceName = '无输入'
    $('fileInput').value = ''
    $('rows').innerHTML = '<tr><td colspan="9" class="empty">还没有分析记录</td></tr>'
    updateCards(null, null, null, null)
    $('sourceLabel').textContent = '无输入'
    setStatus('已清空。')
    draw()
  })
  $('clickBtn').addEventListener('click', analyzeClick)
  $('fileInput').addEventListener('change', function (event) {
    readFile(event.target.files && event.target.files[0])
  })
  $('intervalMs').addEventListener('change', function () { if (running) startTimer() })
  $('windowSeconds').addEventListener('change', draw)
  $('expectedBpm').addEventListener('input', function () {
    if (lastAnalyzed) updateCards({ bpm: lastBpm, confidence: 0, beats: lastBeats }, null, null, lastAnalyzed.length / currentRate())
  })
  window.addEventListener('resize', draw)

  updateCards(null, null, null, null)
  draw()
})()
