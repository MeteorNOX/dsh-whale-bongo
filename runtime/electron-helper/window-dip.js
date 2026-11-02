'use strict'

/**
 * Convert DWM physical-pixel window rectangles to DIP rectangles relative to
 * the overlay's content origin.
 *
 * DWM's DWMWA_EXTENDED_FRAME_BOUNDS is always expressed in physical pixels,
 * even for DPI-unaware callers. The renderer, however, lays out in CSS pixels
 * (DIP), so forwarding the raw rectangles shifts every snap by the monitor
 * scale factor (e.g. 1.5x at Windows 150%).
 */
function windowsToOverlayDip(list, options) {
  const opts = options || {}
  const origin = opts.origin || { x: 0, y: 0 }
  const viewportWidth = Number(opts.width)
  const viewportHeight = Number(opts.height)
  const scaleFactor = Number(opts.scaleFactor) > 0 ? Number(opts.scaleFactor) : 1
  const toDipRect = typeof opts.toDipRect === 'function' ? opts.toDipRect : null
  if (!Array.isArray(list) || !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)) return []

  const converted = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item) continue
    const left = Number(item.left)
    const top = Number(item.top)
    const right = Number(item.right)
    const bottom = Number(item.bottom)
    if (![left, top, right, bottom].every(Number.isFinite)) continue
    const physicalWidth = right - left
    const physicalHeight = bottom - top
    if (physicalWidth <= 0 || physicalHeight <= 0) continue

    let dip
    try {
      const physical = { x: left, y: top, width: physicalWidth, height: physicalHeight }
      dip = toDipRect
        ? toDipRect(physical)
        : { x: left / scaleFactor, y: top / scaleFactor, width: physicalWidth / scaleFactor, height: physicalHeight / scaleFactor }
    } catch (error) {
      continue
    }
    if (!dip) continue
    const dl = Number(dip.x)
    const dt = Number(dip.y)
    const dw = Number(dip.width)
    const dh = Number(dip.height)
    if (![dl, dt, dw, dh].every(Number.isFinite) || dw <= 0 || dh <= 0) continue

    const localLeft = dl - Number(origin.x || 0)
    const localTop = dt - Number(origin.y || 0)
    const localRight = localLeft + dw
    const localBottom = localTop + dh

    // The overlay only covers the primary work area. Windows completely on
    // another monitor would otherwise be clamped to the overlay edge.
    if (localRight <= 0 || localBottom <= 0 || localLeft >= viewportWidth || localTop >= viewportHeight) continue

    converted.push({
      hwnd: String(item.hwnd),
      title: item.title || '',
      left: localLeft,
      top: localTop,
      right: localRight,
      bottom: localBottom,
    })
  }
  return converted
}

module.exports = { windowsToOverlayDip }
