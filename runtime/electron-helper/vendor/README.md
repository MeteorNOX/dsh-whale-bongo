# Vendored beat detector

`beat-detect.js` is a browser IIFE bundle of the `detect()` entry point from
[`@audio/beat@2.1.0`](https://github.com/audiojs/beat), built with esbuild.

- Upstream license: MIT, copyright Dmitry Iv (see `beat-detect.LICENSE`).
- The bundle contains the `@audio/beat-*` atom implementations used by
  `detect()`; no runtime npm dependency is required.
- It exposes `globalThis.WhaleBeat.detect(samples, options)` and is loaded only
  by the desktop helper before `audio-beat.js`.
- Rebuild from a temporary package install with:

  ```text
  npm install @audio/beat@2.1.0 esbuild
  echo "import { detect } from '@audio/beat'; globalThis.WhaleBeat = { detect }" > beat-entry.js
  ./node_modules/.bin/esbuild beat-entry.js --bundle --minify --format=iife --outfile=beat-detect.js
  ```

The wrapper `audio-beat.js` captures system audio, keeps an eight-second
rolling buffer, and schedules detected beat-grid positions against
`AudioContext.currentTime`.
