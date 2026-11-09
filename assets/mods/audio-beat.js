/* ============================================================================
 * MOD · 音乐律动
 * ----------------------------------------------------------------------------
 * 桌面挂件的可选音律动模块。它只负责两件事：
 *   1. 在设置菜单的 MOD 小节里渲染开关和连接状态；
 *   2. 把 helper 送来的节拍事件交给主挂件，复用鼠标点按的按压动效。
 *
 * audio-beat.js（helper 侧）负责系统音频采集和 BPM/节拍网格；本模块不碰
 * 音频权限，也不改变吸附位置。
 * ==========================================================================*/
(function (global) {
  'use strict'

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  function create(host) {
    var cfg = host.cfg || {}
    var desktopMode = Boolean(host.desktopMode)
    var enabled = true
    var status = 'stopped'
    var error = ''
    var bpm = 0
    var period = 0
    var targetPeriod = 0
    var eventMs = 0
    var eventPeriod = 0
    var lead = clamp(Number(host.cfg && host.cfg.audioBeatLead) || 0, -100, 150)
    var input = null
    var statusEl = null
    var leadInput = null
    var leadValue = null

    function isEnabled() {
      return enabled !== false && cfg.audioBeat !== false
    }

    function leadText() {
      if (lead > 0) return '提前 ' + lead + ' ms'
      if (lead < 0) return '延后 ' + (-lead) + ' ms'
      return '不提前'
    }

    function applyLead() {
      // The helper-side scheduler reads this global on every tick. Keeping it
      // in the renderer avoids an IPC round-trip while the slider is moving.
      try { global.__DSH_WHALE_AUDIO_BEAT_LEAD = lead } catch (e) {}
    }

    function statusText() {
      if (!isEnabled()) return '已关闭'
      if (!desktopMode) return '仅在桌面模式生效'
      if (status === 'starting') return '正在申请系统音频…'
      if (status === 'active') {
        return '已连接系统音频' + (bpm > 0 ? ' · ' + Math.round(bpm) + ' BPM' : '')
      }
      if (status === 'error') return error || '系统音频不可用'
      return '等待桌面音频'
    }

    function sync() {
      if (input) input.checked = isEnabled()
      if (leadInput) leadInput.value = String(lead)
      if (leadValue) leadValue.textContent = leadText()
      if (statusEl) {
        statusEl.textContent = statusText()
        statusEl.classList.toggle('is-error', status === 'error' && isEnabled())
        statusEl.classList.toggle('is-active', status === 'active' && isEnabled())
      }
      applyLead()
    }

    function mount(slot) {
      if (!slot) return
      slot.innerHTML =
        '<div class="dsnw-mod-title">MOD · 音乐律动</div>' +
        '<label class="dsnw-toggle-row">' +
          '<span class="dsnw-toggle-label">桌面模式随系统声音律动</span>' +
          '<input type="checkbox" data-mod-audio-beat>' +
          '<span class="dsnw-toggle-track" aria-hidden="true"></span>' +
        '</label>' +
        '<p class="dsnw-image-name" data-mod-audio-beat-status>桌面模式默认开启</p>' +
        '<div class="dsnw-mod-slider-head">' +
          '<span class="dsnw-toggle-label">节拍提前量</span>' +
          '<span class="dsnw-mod-slider-value" data-mod-audio-lead-value>不提前</span>' +
        '</div>' +
        '<input class="dsnw-mod-range" type="range" min="-100" max="150" step="5" data-mod-audio-lead aria-label="节拍提前量">' +
        '<p class="dsnw-image-name">每个拍点按一次，复用鼠标点按的按压动效；正值提前，负值延后</p>'
      input = slot.querySelector('[data-mod-audio-beat]')
      statusEl = slot.querySelector('[data-mod-audio-beat-status]')
      leadInput = slot.querySelector('[data-mod-audio-lead]')
      leadValue = slot.querySelector('[data-mod-audio-lead-value]')
      if (input) {
        input.addEventListener('change', function () {
          cfg.audioBeat = Boolean(this.checked)
          host.save()
          sync()
        })
      }
      if (leadInput) {
        leadInput.addEventListener('input', function () {
          lead = clamp(Number(this.value) || 0, -100, 150)
          cfg.audioBeatLead = lead
          host.save()
          sync()
        })
      }
      sync()
    }

    function setEnabled(value) {
      enabled = value !== false
      sync()
    }

    function setStatus(next, detail, nextBpm) {
      status = next || 'stopped'
      error = detail || ''
      bpm = Number(nextBpm) > 0 ? Number(nextBpm) : 0
      if (status !== 'active' || !(bpm > 0)) {
        targetPeriod = 0
        eventMs = 0
        eventPeriod = 0
      } else {
        targetPeriod = 60 / bpm
        if (!(period > 0)) period = targetPeriod
      }
      sync()
    }

    function pulse() {
      if (!desktopMode || !isEnabled() || status !== 'active') return
      var now = (global.performance && typeof global.performance.now === 'function')
        ? global.performance.now()
        : Date.now()
      var elapsed = eventMs > 0 ? (now - eventMs) / 1000 : 0
      var visualPeriod = eventPeriod > 0 ? eventPeriod : period
      if (elapsed > 0 && visualPeriod > 0) {
        // Ignore duplicate/early events and late catch-up events; a beat is
        // only allowed to trigger the click-style press once per period.
        if (elapsed < visualPeriod * 0.55) return
        if (elapsed > visualPeriod * 1.65) {
          eventMs = now
          return
        }
      }
      if (elapsed > 0.18 && elapsed < 2.4) {
        eventPeriod = eventPeriod > 0
          ? eventPeriod + (elapsed - eventPeriod) * 0.35
          : elapsed
      }
      eventMs = now
      if (typeof host.pressBeat === 'function') host.pressBeat(1)
    }

    function update(dt) {
      if (!dt) return
      if (targetPeriod > 0) {
        period += (targetPeriod - period) * (1 - Math.exp(-dt * 2))
      } else {
        period += (0 - period) * (1 - Math.exp(-dt * 10))
        if (period < 0.01) period = 0
      }
    }

    applyLead()

    return {
      mount: mount,
      sync: sync,
      isEnabled: isEnabled,
      setEnabled: setEnabled,
      setStatus: setStatus,
      pulse: pulse,
      update: update
    }
  }

  global.DSHWhaleBongoMods = global.DSHWhaleBongoMods || {}
  global.DSHWhaleBongoMods.audioBeat = create
})(window)
