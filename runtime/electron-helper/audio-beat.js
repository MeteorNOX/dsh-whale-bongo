/* System-audio beat tracker for the desktop helper.
 *
 * Runs in the active overlay renderer. The main process grants a loopback
 * display-capture request; this module throws away the video track and keeps
 * only the system audio. A rolling eight-second mono buffer is passed to the
 * vendored MIT @audio/beat detector, which returns a tempo and a phase-aligned
 * beat grid. The grid is scheduled against AudioContext time so the widget
 * reacts to musical beats instead of individual bass-energy spikes.
 *
 * Nothing is recorded, stored, or sent outside this process.
 */
(function () {
  'use strict'

  var WINDOW_SECONDS = 8
  var ANALYZE_MS = 1800
  var TICK_MS = 25
  var MIN_BPM = 60
  var MAX_BPM = 180

  function number(value, fallback) {
    var n = Number(value)
    return isFinite(n) ? n : fallback
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max)
  }

  function friendlyError(error) {
    var name = error && error.name ? String(error.name) : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') return '系统音频权限被拒绝'
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有可用的系统声音'
    if (name === 'NotSupportedError') return '当前系统不支持回声消除音频'
    var message = error && error.message ? String(error.message) : ''
    if (message && message.length < 160) return message
    return '无法读取系统声音'
  }

  window.createWhaleAudioBeat = function createWhaleAudioBeat(options) {
    var opts = options || {}
    var running = false
    var starting = false
    var stream = null
    var context = null
    var source = null
    var processor = null
    var silentGain = null
    var timer = 0
    var analyzeTimer = 0
    var ring = null
    var ringSize = 0
    var ringWrite = 0
    var ringFilled = 0
    var beatCount = 0
    var bpm = 0
    var confidence = 0
    var beatPeriod = 0
    var nextBeatAt = 0
    var lastBeatAt = 0
    var lastGridAt = 0
    var worker = null
    var analysisPending = false
    var analysisId = 0
    var analysisDuration = 0

    function status(state, detail) {
      try {
        if (typeof opts.onStatus === 'function') {
          opts.onStatus({
            state: state,
            error: detail || '',
            bpm: bpm,
            confidence: confidence,
          })
        }
      } catch (e) {}
    }

    function release() {
      if (timer) {
        try { window.clearInterval(timer) } catch (e) {}
        timer = 0
      }
      if (analyzeTimer) {
        try { window.clearInterval(analyzeTimer) } catch (e) {}
        analyzeTimer = 0
      }
      if (worker) {
        try { worker.terminate() } catch (e) {}
        worker = null
      }
      analysisPending = false
      if (processor) {
        try { processor.disconnect() } catch (e) {}
        processor.onaudioprocess = null
        processor = null
      }
      if (silentGain) {
        try { silentGain.disconnect() } catch (e) {}
        silentGain = null
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
      if (context) {
        try { context.close() } catch (e) {}
        context = null
      }
      ring = null
      ringSize = 0
      ringWrite = 0
      ringFilled = 0
      beatPeriod = 0
      nextBeatAt = 0
      lastGridAt = 0
    }

    function ensureRing(size) {
      if (ring && ringSize === size) return
      ringSize = size
      ring = new Float32Array(size)
      ringWrite = 0
      ringFilled = 0
    }

    function pushSamples(input) {
      if (!input || !input.length) return
      ensureRing(Math.ceil(context.sampleRate * WINDOW_SECONDS))
      for (var i = 0; i < input.length; i++) {
        ring[ringWrite] = input[i]
        ringWrite = (ringWrite + 1) % ringSize
        if (ringFilled < ringSize) ringFilled++
      }
    }

    function readRing() {
      var out = new Float32Array(ringFilled)
      if (!ringFilled) return out
      var start = (ringWrite - ringFilled + ringSize) % ringSize
      var first = Math.min(ringFilled, ringSize - start)
      out.set(ring.subarray(start, start + first), 0)
      if (first < ringFilled) out.set(ring.subarray(0, ringFilled - first), first)
      return out
    }

    function applyBeatResult(result, duration) {
      if (!running || !context) return
      if (!result || !(result.bpm > 0) || !result.beats || result.beats.length < 2) {
        if (lastGridAt && Date.now() - lastGridAt > 4200) {
          bpm = 0
          confidence = 0
          beatPeriod = 0
          nextBeatAt = 0
          lastGridAt = 0
          status('active')
        }
        return
      }
      var nextBpm = clamp(number(result.bpm, 0), MIN_BPM, MAX_BPM)
      if (!nextBpm) return
      var nextPeriod = 60 / nextBpm
      var last = Number(result.beats[result.beats.length - 1]) || 0
      var next = last + nextPeriod
      // Detect can place the last grid point slightly before the end of the
      // buffer. Move to the first grid point that is still in the future.
      while (next < duration - 0.04) next += nextPeriod
      var now = context.currentTime
      var target = now + Math.max(0.08, next - duration)
      // Do not let a stale grid schedule a beat in the past.
      while (target < now + 0.06) target += nextPeriod
      // Keep a small amount of phase continuity while the tempo is stable;
      // re-anchoring on every analysis would make the pet jitter.
      if (bpm && Math.abs(nextBpm - bpm) < 4 && nextBeatAt > now + 0.05) {
        var drift = target - nextBeatAt
        if (Math.abs(drift) < 0.10) target = nextBeatAt
      }
      bpm = nextBpm
      confidence = clamp(number(result.confidence, 0), 0, 1)
      lastGridAt = Date.now()
      beatPeriod = nextPeriod
      nextBeatAt = target
      status('active')
    }

    function analyze() {
      if (!running || !context || !ringFilled || analysisPending) return
      if (ringFilled < context.sampleRate * 2.4) return
      var samples = readRing()
      var duration = samples.length / context.sampleRate
      if (worker) {
        var id = ++analysisId
        analysisPending = true
        analysisDuration = duration
        try {
          worker.postMessage({
            id: id,
            samples: samples,
            fs: context.sampleRate,
            minBpm: MIN_BPM,
            maxBpm: MAX_BPM,
          }, [samples.buffer])
        } catch (e) {
          analysisPending = false
        }
        return
      }
      if (!window.WhaleBeat || typeof window.WhaleBeat.detect !== 'function') return
      try {
        var result = window.WhaleBeat.detect(samples, {
          fs: context.sampleRate,
          minBpm: MIN_BPM,
          maxBpm: MAX_BPM,
        })
        applyBeatResult(result, duration)
      } catch (e) {}
    }

    function tick() {
      if (!running || !context || !beatPeriod || !nextBeatAt || !lastGridAt) return
      // Music stopped or the detector lost the grid: stop scheduling instead of
      // pulsing forever on the last tempo.
      if (Date.now() - lastGridAt > 5200) return
      var now = context.currentTime
      // A slow analysis can leave the grid slightly behind; skip stale beats
      // instead of firing a burst to catch up.
      while (nextBeatAt < now - beatPeriod * 0.35) nextBeatAt += beatPeriod
      if (now < nextBeatAt) return
      if (lastBeatAt && now - lastBeatAt < beatPeriod * 0.45) {
        nextBeatAt = now + beatPeriod
        return
      }
      lastBeatAt = now
      beatCount += 1
      var strength = clamp(0.62 + confidence * 0.38, 0.55, 1)
      try {
        if (typeof opts.onBeat === 'function') {
          opts.onBeat({
            strength: strength,
            bpm: bpm,
            confidence: confidence,
            at: Date.now(),
          })
        }
      } catch (e) {}
      nextBeatAt += beatPeriod
    }

    async function start() {
      if (running || starting) return
      starting = true
      status('starting')
      try {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
          throw new Error('当前环境不支持系统音频采集')
        }
        if (!window.WhaleBeat || typeof window.WhaleBeat.detect !== 'function') {
          throw new Error('节拍检测模块未加载')
        }
        var nextStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        })
        if (!starting) {
          try { nextStream.getTracks().forEach(function (track) { track.stop() }) } catch (e) {}
          return
        }
        stream = nextStream
        // The video track is only a transport requirement for loopback audio.
        // Stop it immediately so screen capture does not keep encoding frames.
        try {
          stream.getVideoTracks().forEach(function (track) { track.stop() })
        } catch (e) {}
        var audioTrack = stream.getAudioTracks()[0]
        if (!audioTrack) throw new Error('当前系统没有提供可用的音频轨道')

        var AudioContextClass = window.AudioContext || window.webkitAudioContext
        if (!AudioContextClass) throw new Error('当前环境不支持 Web Audio')
        context = new AudioContextClass()
        if (context.state === 'suspended') {
          try { await context.resume() } catch (e) {}
        }
        ensureRing(Math.ceil(context.sampleRate * WINDOW_SECONDS))
        try {
          worker = new Worker('./audio-beat-worker.js')
          worker.onmessage = function (event) {
            analysisPending = false
            var data = event.data || {}
            if (!running || data.id !== analysisId || data.error) return
            applyBeatResult(data, analysisDuration)
          }
          worker.onerror = function () {
            // Fall back to the synchronous detector if the worker cannot load.
            try { worker.terminate() } catch (e) {}
            worker = null
            analysisPending = false
          }
        } catch (e) {
          worker = null
        }
        source = context.createMediaStreamSource(new MediaStream([audioTrack]))
        processor = context.createScriptProcessor(4096, 1, 1)
        processor.onaudioprocess = function (event) {
          if (!running) return
          try { pushSamples(event.inputBuffer.getChannelData(0)) } catch (e) {}
        }
        // ScriptProcessorNode only receives audio while connected to the
        // destination. A muted gain keeps the loopback inaudible.
        silentGain = context.createGain()
        silentGain.gain.value = 0
        source.connect(processor)
        processor.connect(silentGain)
        silentGain.connect(context.destination)

        audioTrack.onended = function () {
          if (!running && !starting) return
          running = false
          starting = false
          release()
          status('stopped')
        }

        running = true
        starting = false
        beatCount = 0
        bpm = 0
        confidence = 0
        beatPeriod = 0
        nextBeatAt = 0
        lastBeatAt = 0
        lastGridAt = 0
        timer = window.setInterval(tick, TICK_MS)
        analyzeTimer = window.setInterval(analyze, ANALYZE_MS)
        status('active')
      } catch (error) {
        starting = false
        running = false
        release()
        status('error', friendlyError(error))
      }
    }

    function stop() {
      var wasRunning = running || starting
      running = false
      starting = false
      release()
      if (wasRunning) status('stopped')
    }

    function state() {
      return {
        running: running,
        starting: starting,
        beats: beatCount,
        bpm: bpm,
        confidence: confidence,
        energy: 0,
        baseline: 0,
        rise: 0,
      }
    }

    return { start: start, stop: stop, state: state }
  }
})()
