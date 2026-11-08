/* System-audio beat detector for the desktop helper.
 *
 * Runs in the active overlay renderer. The main process grants a loopback
 * display-capture request; this module throws away the video track and keeps
 * only the system audio, then emits short beat events. Nothing is recorded,
 * stored, or sent outside this process.
 */
(function () {
  'use strict'

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
    var analyser = null
    var samples = null
    var timer = 0
    var baseline = 0
    var riseBaseline = 0
    var previousEnergy = 0
    var lastBeatAt = 0
    var startedAt = 0
    var beatCount = 0
    var lastEnergy = 0
    var lastRise = 0

    function status(state, detail) {
      try {
        if (typeof opts.onStatus === 'function') {
          opts.onStatus({ state: state, error: detail || '' })
        }
      } catch (e) {}
    }

    function release() {
      if (timer) {
        try { window.clearInterval(timer) } catch (e) {}
        timer = 0
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
      analyser = null
      samples = null
      baseline = 0
      riseBaseline = 0
      previousEnergy = 0
      lastEnergy = 0
      lastRise = 0
    }

    function sample() {
      if (!running || !analyser || !context) return
      try {
        analyser.getByteFrequencyData(samples)
      } catch (e) {
        return
      }
      var hzPerBin = context.sampleRate / analyser.fftSize
      // Kick drums and bass lines carry most of the beat. Stay below 220 Hz
      // so speech and high-frequency clicks do not make the pet flicker.
      var lastBin = Math.min(samples.length - 1, Math.max(1, Math.round(220 / hzPerBin)))
      var energy = 0
      for (var i = 1; i <= lastBin; i++) energy += samples[i]
      energy /= lastBin
      lastEnergy = energy

      var rise = Math.max(0, energy - previousEnergy)
      previousEnergy = energy
      lastRise = rise

      var now = Date.now()
      if (!baseline) {
        baseline = energy
        riseBaseline = rise
      }
      // Track the average bass level, but detect the leading edge of a kick
      // or bass note. Absolute energy alone stays high through a loud chorus,
      // so it would either miss beats or pulse continuously.
      baseline += (energy - baseline) * (energy > baseline ? 0.08 : 0.02)
      riseBaseline += (rise - riseBaseline) * (rise > riseBaseline ? 0.10 : 0.02)
      if (now - startedAt < 420) return

      var noiseFloor = Math.max(6, baseline * 0.55)
      var riseThreshold = Math.max(3, riseBaseline * 1.2 + 2)
      if (rise < riseThreshold || energy < noiseFloor || now - lastBeatAt < 180) return
      lastBeatAt = now
      beatCount += 1
      var strength = clamp((rise - riseThreshold) / (riseThreshold * 2 + 8), 0.25, 1)
      try {
        if (typeof opts.onBeat === 'function') {
          opts.onBeat({ strength: strength, energy: energy, baseline: baseline, at: now })
        }
      } catch (e) {}
    }

    async function start() {
      if (running || starting) return
      starting = true
      status('starting')
      try {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
          throw new Error('当前环境不支持系统音频采集')
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
        source = context.createMediaStreamSource(new MediaStream([audioTrack]))
        analyser = context.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.22
        analyser.minDecibels = -92
        analyser.maxDecibels = -8
        source.connect(analyser)
        samples = new Uint8Array(analyser.frequencyBinCount)

        audioTrack.onended = function () {
          if (!running && !starting) return
          running = false
          starting = false
          release()
          status('stopped')
        }

        startedAt = Date.now()
        baseline = 0
        lastBeatAt = 0
        beatCount = 0
        running = true
        starting = false
        timer = window.setInterval(sample, 32)
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
        energy: lastEnergy,
        baseline: baseline,
        rise: lastRise,
      }
    }

    return { start: start, stop: stop, state: state }
  }
})()
