/* Beat-grid analysis worker. Keeping the FFT/tempo pass off the renderer
 * thread avoids a dropped frame every analysis interval while the widget is
 * following a window. */
'use strict'

importScripts('./vendor/beat-detect.js')

self.onmessage = function (event) {
  var data = event.data || {}
  if (!data.samples) return
  var detector = self.WhaleBeat
  if (!detector || typeof detector.detect !== 'function') return
  try {
    var startedAt = performance.now()
    var result = detector.detect(data.samples, {
      fs: data.fs,
      minBpm: data.minBpm || 60,
      maxBpm: data.maxBpm || 180,
    })
    self.postMessage({
      id: data.id,
      bpm: result.bpm,
      confidence: result.confidence,
      beats: Array.from(result.beats || []),
      ms: Math.max(0, performance.now() - startedAt),
    })
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error && error.message || error) })
  }
}
