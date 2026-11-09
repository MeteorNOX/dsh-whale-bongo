const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

test('audio beat mod triggers one press per accepted beat', () => {
  let now = 1000;
  const context = {
    window: { performance: { now: () => now } },
    console,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('assets/mods/audio-beat.js', 'utf8'), context);

  const presses = [];
  const mod = context.window.DSHWhaleBongoMods.audioBeat({
    cfg: { audioBeat: true, audioBeatLead: 70 },
    desktopMode: true,
    save() {},
    pressBeat(strength) { presses.push({ at: now, strength }); },
  });
  assert.equal(context.window.__DSH_WHALE_AUDIO_BEAT_LEAD, 70);
  mod.setStatus('active', '', 120);

  mod.pulse();
  assert.equal(presses.length, 1);

  now = 1200;
  mod.pulse();
  assert.equal(presses.length, 1, 'early duplicate must not press again');

  now = 1500;
  mod.pulse();
  assert.equal(presses.length, 2);

  now = 2900;
  mod.pulse();
  assert.equal(presses.length, 2, 'late catch-up must not press again');
});
