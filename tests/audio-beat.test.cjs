'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const detectorPath = path.join(__dirname, '..', 'runtime', 'electron-helper', 'vendor', 'beat-detect.js')
require(detectorPath)

function clickTrack(fs, seconds, bpm) {
  const data = new Float32Array(fs * seconds)
  const period = 60 / bpm
  for (let beat = 0; beat < seconds / period; beat += 1) {
    const start = Math.round(beat * period * fs)
    for (let i = 0; i < Math.min(1200, data.length - start); i += 1) {
      const t = i / fs
      data[start + i] += Math.sin(2 * Math.PI * 80 * t) * Math.exp(-t * 30) * 0.9
    }
  }
  return data
}

test('vendored @audio/beat detects a 120 BPM grid', () => {
  const fs = 44100
  const samples = clickTrack(fs, 12, 120)
  const result = globalThis.WhaleBeat.detect(samples, { fs, minBpm: 60, maxBpm: 180 })
  assert.ok(Math.abs(result.bpm - 120) <= 2, `expected ~120 BPM, got ${result.bpm}`)
  assert.ok(result.beats.length >= 12, `expected a beat grid, got ${result.beats.length} beats`)
  assert.ok(result.confidence > 0.4, `expected confidence > 0.4, got ${result.confidence}`)
})
