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
  var SOUND_WARMUP_MS = 3000
  // The widget's beat press has a ~55ms press shape before its lowest point.
  // Fire the event this much before the musical beat so the visual bottom
  // lands on the beat. The MOD slider adds/subtracts extra lead.
  var PRESS_LEAD_MS = 55
  var HARMONIC_TOLERANCE = 0.035

  function number(value, fallback) {
    var n = Number(value)
    return isFinite(n) ? n : fallback
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max)
  }

  function userLeadMs() {
    return clamp(number(window.__DSH_WHALE_AUDIO_BEAT_LEAD, 0), -100, 150)
  }

  function pressLeadSeconds() {
    return (PRESS_LEAD_MS + userLeadMs()) / 1000
  }

  function harmonicRatio(nextBpm, currentBpm) {
    if (!currentBpm) return false
    var ratio = nextBpm / currentBpm
    var targets = [0.5, 2 / 3, 0.75, 4 / 3, 1.5, 2]
    for (var i = 0; i < targets.length; i++) {
      if (Math.abs(ratio - targets[i]) <= HARMONIC_TOLERANCE) return true
    }
    return false
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
    var beatTimer = 0
    var scheduledLead = -1
    var lastSoundAt = 0
    var soundStartAt = 0
    var currentRms = 0
    var suppressUntil = 0
    var candidateBpm = 0
    var candidateHits = 0
    var candidateRequired = 0
    var currentState = 'stopped'
    var currentError = ''
    var analysisCount = 0
    var lastAnalysisMs = 0
    var analysisStartedAt = 0
    var lastResult = null
    var lastTelemetryAt = 0

    function telemetry(force) {
      if (typeof opts.onTelemetry !== 'function') return
      var nowMs = Date.now()
      if (!force && nowMs - lastTelemetryAt < 100) return
      lastTelemetryAt = nowMs
      var previous = lastResult
      var lead = pressLeadSeconds()
      var payload = {
        at: nowMs,
        state: currentState,
        error: currentError,
        enabled: running || starting,
        bpm: bpm,
        confidence: confidence,
        beatPeriod: beatPeriod,
        beatCount: beatCount,
        analysisCount: analysisCount,
        analysisMs: lastAnalysisMs,
        analysisEveryMs: ANALYZE_MS,
        windowSeconds: WINDOW_SECONDS,
        sampleRate: context ? context.sampleRate : 0,
        bufferSeconds: context && ringFilled ? ringFilled / context.sampleRate : 0,
        audioTime: context ? context.currentTime : 0,
        nextBeatAt: nextBeatAt,
        nextBeatIn: context && nextBeatAt ? nextBeatAt - context.currentTime : 0,
        nextPressIn: context && nextBeatAt ? nextBeatAt - lead - context.currentTime : 0,
        leadMs: Math.round(lead * 1000),
        userLeadMs: userLeadMs(),
        pressLeadMs: PRESS_LEAD_MS,
        energy: currentRms,
        audible: isAudible(),
        suppressed: nowMs < suppressUntil,
        suppressLeftMs: Math.max(0, suppressUntil - nowMs),
        gridAgeMs: lastGridAt ? nowMs - lastGridAt : 0,
        candidateBpm: candidateBpm,
        candidateHits: candidateHits,
        candidateRequired: candidateRequired,
        last: previous ? {
          bpm: previous.bpm,
          confidence: previous.confidence,
          ms: previous.ms,
          duration: previous.duration,
          beats: previous.beats.slice(-32),
        } : null,
      }
      try { opts.onTelemetry(payload) } catch (e) {}
    }

    function status(state, detail) {
      currentState = state || 'stopped'
      currentError = detail || ''
      telemetry(true)
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

    function clearBeatTimer() {
      if (beatTimer) {
        try { window.clearTimeout(beatTimer) } catch (e) {}
        beatTimer = 0
      }
      scheduledLead = -1
    }

    function scheduleBeat() {
      clearBeatTimer()
      if (!running || !context || !beatPeriod || !nextBeatAt) return
      var lead = pressLeadSeconds()
      var delay = (nextBeatAt - lead - context.currentTime) * 1000
      if (!isFinite(delay)) return
      beatTimer = window.setTimeout(fireBeat, Math.max(0, delay))
      scheduledLead = lead
    }

    function fireBeat() {
      beatTimer = 0
      if (!running || !context || !beatPeriod || !nextBeatAt) return
      var now = context.currentTime
      var lead = pressLeadSeconds()
      var due = nextBeatAt - lead
      // Timers can wake slightly early; wait rather than double-fire.
      if (now + 0.003 < due) {
        scheduleBeat()
        return
      }
      // A suspended window or long main-thread stall must not produce a burst
      // of catch-up presses. Skip the missed beat and re-anchor the next one.
      if (now > due + beatPeriod * 0.60) {
        nextBeatAt = now + beatPeriod
        scheduleBeat()
        return
      }
      if (lastBeatAt && now - lastBeatAt < beatPeriod * 0.40) {
        scheduleBeat()
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
            scheduledAt: nextBeatAt,
            firedAt: now,
          })
        }
      } catch (e) {}
      nextBeatAt += beatPeriod
      telemetry(true)
      scheduleBeat()
    }

    function clearBeatGrid(notify) {
      clearBeatTimer()
      var hadGrid = Boolean(bpm || beatPeriod || nextBeatAt || lastGridAt)
      bpm = 0
      confidence = 0
      beatPeriod = 0
      nextBeatAt = 0
      lastGridAt = 0
      candidateBpm = 0
      candidateHits = 0
      candidateRequired = 0
      lastBeatAt = 0
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
      clearBeatTimer()
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
      candidateRequired = 0
      lastBeatAt = 0
      scheduledLead = 0
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
      if (!isAudible()) {
        clearBeatGrid(true)
        return
      }
      if (!result || !(result.bpm > 0) || !Array.isArray(result.beats)) return

      // @audio/beat repeats the window edge as a synthetic beat. Dropping it
      // avoids short 147–352ms intervals in the analysis log and keeps the
      // grid anchored to real detected onsets.
      var offsets = []
      var rawBeats = Array.isArray(result.beats) ? result.beats : []
      for (var bi = 0; bi < rawBeats.length; bi++) {
        var offset = number(rawBeats[bi], NaN) - duration
        if (!isFinite(offset)) continue
        if (offset <= -duration + 0.05) continue
        if (offset > 0.02) continue
        if (offsets.length && offset - offsets[offsets.length - 1] < 0.04) continue
        offsets.push(offset)
      }
      if (offsets.length < 2) return

      lastResult = {
        bpm: Number(result.bpm) || 0,
        confidence: Number(result.confidence) || 0,
        ms: Number(result.ms) || lastAnalysisMs,
        duration: duration,
        beats: offsets,
      }
      if (Date.now() < suppressUntil) {
        // Hold the current grid/phase while the widget's own typing sound
        // masks the analysis. The next non-suppressed analysis can correct it.
        return
      }

      var nextBpm = clamp(number(result.bpm, 0), MIN_BPM, MAX_BPM)
      if (!nextBpm) return
      var nextConfidence = clamp(number(result.confidence, 0), 0, 1)

      // Require a longer confirmation window for large changes and for
      // half/double/triplet tempo relationships. A 112→168 (3:2) misread can
      // otherwise persist for several seconds and produces a burst of fast
      // presses. Small 112↔113 fluctuations are accepted immediately so the
      // grid does not get stuck.
      var requiredHits = 0
      if (!bpm) {
        requiredHits = nextBpm > 140 ? 3 : 0
      } else {
        var diff = Math.abs(nextBpm - bpm)
        if (diff > 2.5) {
          if (harmonicRatio(nextBpm, bpm)) requiredHits = 6
          else if (diff > 12 || diff > bpm * 0.18) requiredHits = 3
          else requiredHits = 2
        }
      }
      if (requiredHits > 0) {
        if (nextConfidence < 0.45) return
        if (candidateBpm && Math.abs(nextBpm - candidateBpm) <= 3) {
          candidateHits += 1
        } else {
          candidateBpm = nextBpm
          candidateHits = 1
        }
        candidateRequired = requiredHits
        if (candidateHits < requiredHits) {
          status('active')
          telemetry(true)
          return
        }
      }

      var nextPeriod = 60 / nextBpm
      var last = Number(offsets[offsets.length - 1]) || 0
      var now = context.currentTime
      var bufferEnd = ringEndedAt || now
      var target = bufferEnd + Math.max(0.02, last + nextPeriod)
      while (target < now + 0.03) target += nextPeriod

      if (!bpm) {
        nextBeatAt = target
        beatPeriod = nextPeriod
      } else if (Math.abs(nextBpm - bpm) <= 2.5) {
        // Same tempo (including 112/113): preserve the current phase and timer.
        // Re-anchoring here was the cause of skipped beats (974–1051ms gaps).
        beatPeriod = nextPeriod
        if (!nextBeatAt) nextBeatAt = target
      } else {
        // A real tempo change is applied at a beat boundary. Clamp the target
        // so the new grid cannot introduce a two-beat hole.
        var lower = lastBeatAt ? lastBeatAt + nextPeriod * 0.65 : now + 0.05
        var upper = lastBeatAt ? lastBeatAt + nextPeriod * 1.35 : now + nextPeriod
        target = clamp(target, lower, upper)
        while (target < now + 0.05) target += nextPeriod
        nextBeatAt = target
        beatPeriod = nextPeriod
      }

      bpm = nextBpm
      confidence = nextConfidence
      candidateBpm = 0
      candidateHits = 0
      candidateRequired = 0
      lastGridAt = Date.now()
      status('active')
      scheduleBeat()
    }

    function analyze() {
      if (!running || !context || !ringFilled || analysisPending) return
      if (ringFilled < context.sampleRate * 2.4) return
      // A window that is mostly silence makes @audio/beat return confident but
      // nonsense tempos (125/148/180 BPM). Do not publish any result until the
      // rolling window contains enough real sound.
      if (!soundStartAt || Date.now() - soundStartAt < SOUND_WARMUP_MS) return
      if (!isAudible()) return
      analysisStartedAt = performance.now()
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
        analysisCount += 1
        result.ms = Math.max(0, performance.now() - analysisStartedAt)
        lastAnalysisMs = result.ms
        applyBeatResult(result, duration)
        telemetry(true)
      } catch (e) {}
    }

    function tick() {
      if (!running || !context) return
      telemetry(false)
      if (!isAudible()) {
        clearBeatGrid(true)
        return
      }
      if (!beatPeriod || !nextBeatAt || !lastGridAt) return
      if (Date.now() >= suppressUntil && Date.now() - lastGridAt > 5200) {
        clearBeatGrid(true)
        return
      }
      var now = context.currentTime
      var lead = pressLeadSeconds()
      // If the UI thread was stalled past the beat, skip the missed pulse and
      // re-anchor instead of firing a burst of catch-up presses.
      if (now > nextBeatAt - lead + beatPeriod * 0.65) {
        var missed = Math.floor((now - (nextBeatAt - lead)) / beatPeriod)
        if (missed < 1) missed = 1
        nextBeatAt += beatPeriod * missed
        scheduleBeat()
        return
      }
      if (!beatTimer || Math.abs(scheduledLead - lead) > 0.001) scheduleBeat()
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
            analysisCount += 1
            var data = event.data || {}
            lastAnalysisMs = Number(data.ms) || Math.max(0, performance.now() - analysisStartedAt)
            if (!running || data.id !== analysisId || data.error) return
            applyBeatResult(data, analysisDuration)
            telemetry(true)
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
        analysisCount = 0
        lastAnalysisMs = 0
        lastResult = null
        currentState = 'active'
        currentError = ''
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
        candidateRequired = 0
        clearBeatTimer()
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
        energy: currentRms,
        analysisCount: analysisCount,
        analysisMs: lastAnalysisMs,
        beatPeriod: beatPeriod,
        nextBeatIn: context && nextBeatAt ? nextBeatAt - context.currentTime : 0,
        nextPressIn: context && nextBeatAt ? nextBeatAt - pressLeadSeconds() - context.currentTime : 0,
        leadMs: Math.round(pressLeadSeconds() * 1000),
        bufferSeconds: context && ringFilled ? ringFilled / context.sampleRate : 0,
      }
    }

    return { start: start, stop: stop, state: state, telemetry: function () { telemetry(true) } }
  }
})()
