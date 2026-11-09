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
  var ANALYZE_MS = 1000
  var TICK_MS = 25
  var MIN_BPM = 60
  var MAX_BPM = 180
  var SILENCE_RMS = 0.0025
  var SILENCE_MS = 450
  var STARTUP_LOCK_MS = 1400

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
    var ringEndedAt = 0
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
    var lastSoundAt = 0
    var soundStartAt = 0
    var currentRms = 0
    var suppressUntil = 0
    var candidateBpm = 0
    var candidateHits = 0

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

    function isAudible() {
      return Boolean(lastSoundAt) && Date.now() - lastSoundAt < SILENCE_MS
    }

    function clearBeatGrid(notify) {
      var hadGrid = Boolean(bpm || beatPeriod || nextBeatAt || lastGridAt)
      bpm = 0
      confidence = 0
      beatPeriod = 0
      nextBeatAt = 0
      lastGridAt = 0
      candidateBpm = 0
      candidateHits = 0
      soundStartAt = 0
      if (notify && hadGrid) status('active')
    }

    function suppress(ms) {
      // The widget plays its own press/typing sound through the same system
      // loopback. Ignore analysis around it so that sound is never mistaken
      // for a musical beat. Keep the existing grid running: while typing the
      // nod must hold its current BPM/phase, then accept corrections once the
      // typing pauses and the suppression window expires.
      var duration = clamp(number(ms, 320), 120, 1500)
      suppressUntil = Math.max(suppressUntil, Date.now() + duration)
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
      ringEndedAt = 0
      beatPeriod = 0
      nextBeatAt = 0
      lastGridAt = 0
      lastSoundAt = 0
      soundStartAt = 0
      currentRms = 0
      suppressUntil = 0
      candidateBpm = 0
      candidateHits = 0
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
      var sum = 0
      for (var i = 0; i < input.length; i++) {
        var value = input[i]
        sum += value * value
        ring[ringWrite] = value
        ringWrite = (ringWrite + 1) % ringSize
        if (ringFilled < ringSize) ringFilled++
      }
      currentRms = Math.sqrt(sum / input.length)
      // This is the AudioContext time of the newest sample. Analysis may run
      // tens of milliseconds later; scheduling from "now" would add that
      // delay to every beat and make the visual pulse trail the music.
      ringEndedAt = context.currentTime
      // A frozen/stale BPM grid must not keep animating after the music stops.
      // Count sound even while analysis is suppressed by the widget's own
      // click: otherwise sustained typing would look like silence and cut the
      // nod exactly when it should keep its current tempo until typing ends.
      if (currentRms >= SILENCE_RMS) {
        lastSoundAt = Date.now()
        if (!soundStartAt) soundStartAt = lastSoundAt
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
      if (Date.now() < suppressUntil) {
        // Hold the current grid/phase while the widget's own typing sound
        // masks the analysis. The next non-suppressed analysis can correct it.
        return
      }
      if (!isAudible()) {
        clearBeatGrid(true)
        return
      }
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
      var nextConfidence = clamp(number(result.confidence, 0), 0, 1)
      // A short intro or a sparse first window can make @audio/beat report a
      // double-time tempo. Do not let a high first BPM drive the widget until
      // a second analysis confirms it; also require the grid to be stable
      // after the first audible sample.
      var needsConfirmation = !bpm && nextBpm > 140
      // 123 ↔ 157 BPM is a common half/double-time misread (27.6% apart), so a
      // 28% threshold was just loose enough to let it through. Require a
      // second analysis for any jump over 12 BPM or 18%.
      if (bpm && (Math.abs(nextBpm - bpm) > 12 || Math.abs(nextBpm - bpm) > bpm * 0.18)) {
        needsConfirmation = true
      }
      if (needsConfirmation) {
        if (nextConfidence < 0.45) return
        if (candidateBpm && Math.abs(nextBpm - candidateBpm) <= 4) {
          candidateHits += 1
        } else {
          candidateBpm = nextBpm
          candidateHits = 1
        }
        if (candidateHits < 2) {
          status('active')
          return
        }
      } else {
        candidateBpm = 0
        candidateHits = 0
      }
      if (!bpm && soundStartAt && Date.now() - soundStartAt < STARTUP_LOCK_MS) return
      var nextPeriod = 60 / nextBpm
      var last = Number(result.beats[result.beats.length - 1]) || 0
      var next = last + nextPeriod
      // Detect can place the last grid point slightly before the end of the
      // buffer. Move to the first grid point that is still in the future.
      while (next < duration - 0.04) next += nextPeriod
      var now = context.currentTime
      var bufferEnd = ringEndedAt || now
      var target = bufferEnd + Math.max(0.02, next - duration)
      // Do not let a stale grid schedule a beat in the past.
      while (target < now + 0.03) target += nextPeriod
      // Keep a small amount of phase continuity while the tempo is stable;
      // re-anchoring on every analysis would make the pet jitter.
      if (bpm && Math.abs(nextBpm - bpm) < 4 && nextBeatAt > now + 0.05) {
        var drift = target - nextBeatAt
        if (Math.abs(drift) < 0.10) target = nextBeatAt
      }
      // Never pull the already-scheduled beat earlier. A re-detected tempo
      // that puts the next grid point before it would fire a second nod
      // before the previous one settles, which reads as a stutter. Keep the
      // current beat and let the new period take over after it.
      if (bpm && nextBeatAt > now + 0.05 && target < nextBeatAt) {
        target = nextBeatAt
      }
      bpm = nextBpm
      confidence = nextConfidence
      candidateBpm = 0
      candidateHits = 0
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
      if (!running || !context) return
      if (!isAudible()) {
        clearBeatGrid(true)
        return
      }
      if (!beatPeriod || !nextBeatAt || !lastGridAt) return
      // While the widget's own typing sound is masking analysis, keep the
      // existing grid. Once suppression ends, stop if the detector has not
      // produced a fresh grid recently.
      if (Date.now() >= suppressUntil && Date.now() - lastGridAt > 5200) return
      var now = context.currentTime
      // Positive lead fires early, negative lead fires late. The MOD updates
      // this global while its slider moves, so no IPC round-trip is needed.
      var lead = clamp(number(window.__DSH_WHALE_AUDIO_BEAT_LEAD, 0) / 1000, -0.2, 0.2)
      // A slow analysis can leave the grid slightly behind; skip stale beats
      // instead of firing a burst to catch up.
      while (nextBeatAt - lead < now - beatPeriod * 0.35) nextBeatAt += beatPeriod
      if (now < nextBeatAt - lead) return
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
        lastSoundAt = 0
        soundStartAt = 0
        currentRms = 0
        suppressUntil = 0
        candidateBpm = 0
        candidateHits = 0
        window.__DSH_WHALE_AUDIO_BEAT_SUPPRESS = suppress
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
