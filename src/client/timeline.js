// wiki-plugin-timeline
// Renders a navigable SVG timeline from:
//   - Events authored directly in the item DSL
//   - Date Plugin items upstream in the lineup (when LINEUP keyword present)
//   - Frozen lineup snapshots (item.frozen)


// ── Parser ────────────────────────────────────────────────────────────────────
// DSL (Mermaid gantt-inspired):
//
//   LINEUP                              ← enable live lineup scanning
//   PALETTE warm                        ← named built-in palette
//   PALETTE #e040fb #00e5ff #69f0ae     ← custom hex colours
//   PALETTE red blue green              ← named CSS colours
//   section GroupName                  ← start a named group
//   2026-01-15 Event Label             ← point event
//   2026-02-01..2026-05-30 Event Label ← range event
//   2026-02-01 Event #GroupName        ← inline group tag
//
// Freeze/thaw:
//   ❄ button serialises current events (including LINEUP sources) back into
//   the item text and saves it — removing the LINEUP keyword. The resulting
//   text is fully editable (add PALETTE, adjust dates, etc.). To thaw,
//   double-click the item to edit, clear the event lines, and restore LINEUP.

const parseISO = str => {
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null
}

export const parseText = text => {
  const lines   = (text || '').split(/\n/)
  let lineup    = false
  let section   = null
  let palette   = null
  const events  = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('//')) continue

    if (line === 'LINEUP') { lineup = true; continue }

    const paletteMatch = line.match(/^PALETTE\s+(.+)$/i)
    if (paletteMatch) {
      const arg = paletteMatch[1].trim()
      if (NAMED_PALETTES[arg]) {
        palette = NAMED_PALETTES[arg]
      } else {
        const tokens = arg.split(/\s+/).filter(Boolean)
        if (tokens.length) palette = tokens.map(colourToEntry)
      }
      continue
    }

    const secMatch = line.match(/^section\s+(.+)$/i)
    if (secMatch) { section = secMatch[1].trim(); continue }

    // range: YYYY-MM-DD..YYYY-MM-DD rest
    const rangeMatch = line.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\s*(.*)$/)
    if (rangeMatch) {
      const start = parseISO(rangeMatch[1])
      const end   = parseISO(rangeMatch[2])
      if (start && end) {
        const { label, group } = labelAndGroup(rangeMatch[3], section)
        events.push({ label, start, end, group })
      }
      continue
    }

    // point: YYYY-MM-DD rest
    const pointMatch = line.match(/^(\d{4}-\d{2}-\d{2})\s*(.*)$/)
    if (pointMatch) {
      const start = parseISO(pointMatch[1])
      if (start) {
        const { label, group } = labelAndGroup(pointMatch[2], section)
        events.push({ label, start, end: start, group })
      }
    }
  }

  return { lineup, events, palette }
}

const labelAndGroup = (rest, defaultGroup) => {
  const parts  = (rest || '').trim().split(/\s+/)
  const tagged = parts.findIndex(p => p.startsWith('#'))
  let group    = defaultGroup
  let label    = rest.trim()

  if (tagged >= 0) {
    group = parts[tagged].slice(1)
    label = parts.filter((_, i) => i !== tagged).join(' ').trim()
  }
  return { label, group }
}

// ── Collector ─────────────────────────────────────────────────────────────────
// Scans upstream .calendar-source items in the lineup for calendarData().
// Returns normalised event objects merged with authored events.

export const collect = ($item, item, authoredEvents) => {
  const { lineup } = parseText(item.text)
  if (!lineup) return authoredEvents

  const idx      = $('.item').index($item)
  const upstream = $('.item:lt(' + idx + ')').filter('.calendar-source')
  const lineupEvents = []

  upstream.each(function () {
    const el = this
    if (typeof el.calendarData === 'function') {
      try {
        for (const ev of el.calendarData()) {
          lineupEvents.push({
            label: ev.label || '',
            start: ev.start instanceof Date ? ev.start : new Date(ev.start),
            end:   ev.end   instanceof Date ? ev.end   : new Date(ev.end || ev.start),
            group: ev.group || null,
          })
        }
      } catch (_) {}
    }
  })

  return [...lineupEvents, ...authoredEvents]
}

// ── SVG Renderer ──────────────────────────────────────────────────────────────
// Pure function: events → SVG string.
// Improvements over v1:
//   - Section background bands with coloured left stripe
//   - Greedy row-packing per section (no event collisions)
//   - Adaptive time axis: months for short spans, years for long
//   - Light vertical grid lines at major ticks
//   - Point labels above the circle; bar labels clipped inside wide bars

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const pad2  = n => String(n).padStart(2, '0')
const fmtDate = d => `${pad2(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`
const r2    = n => Math.round(n * 100) / 100
const escXML  = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
const escAttr = s => (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')
// Declarative open-page affordance so frozen timeline capsules stay click-navigable
// in the SVG Plugin (which reads data-fedwiki-action), matching mermaid/diagram nodes.
const fedwikiAttrs = label =>
  label ? ` data-fedwiki-action="open-page" data-fedwiki-page="${escAttr(label)}"` : ''

// Clip string to fit within pixel width (rough 6.2px per char at 10px sans-serif)
const clipText = (s, pxW) => {
  if (!s) return ''
  const max = Math.floor(pxW / 6.2)
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

// Adaptive tick list: { t, label, major }
const generateTicks = (minT, maxT) => {
  const spanDays = (maxT - minT) / 86400000
  const ticks = []

  if (spanDays > 365 * 2.5) {
    // Year major ticks; quarter minor ticks if < 8 years
    const y0 = new Date(minT).getFullYear()
    const y1 = new Date(maxT).getFullYear() + 1
    for (let y = y0; y <= y1; y++) {
      const t = new Date(y, 0, 1).getTime()
      if (t >= minT && t <= maxT) ticks.push({ t, label: String(y), major: true })
      if (spanDays < 365 * 8) {
        for (const m of [3, 6, 9]) {
          const tq = new Date(y, m, 1).getTime()
          if (tq >= minT && tq <= maxT) ticks.push({ t: tq, label: '', major: false })
        }
      }
    }
  } else {
    // Month ticks; label every month if ≤ 12 months, else only Jan
    const d0 = new Date(minT)
    const d1 = new Date(maxT)
    let d = new Date(d0.getFullYear(), d0.getMonth(), 1)
    while (d.getTime() <= d1.getTime()) {
      const isJan = d.getMonth() === 0
      const showLabel = spanDays <= 366 || isJan
      ticks.push({
        t:     d.getTime(),
        label: isJan ? String(d.getFullYear()) : (showLabel ? MONTHS_SHORT[d.getMonth()] : ''),
        major: true,
      })
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1)
    }
  }

  return ticks.sort((a, b) => a.t - b.t)
}

// Greedy interval scheduling: pack events into minimum rows with no overlap
const packRows = (evs, tX) => {
  const rows  = []
  const sorted = [...evs].sort((a, b) => a.start - b.start)
  for (const ev of sorted) {
    const x1 = tX(ev.start.getTime())
    const x2 = tX(ev.end.getTime())
    // A point event's circle takes ~10px; reserve that as its footprint
    const right = (x2 - x1 < 4) ? x1 + 10 : x2
    let placed = false
    for (const row of rows) {
      const prev  = row[row.length - 1]
      const px2   = tX(prev.end.getTime())
      const prevR = (px2 - tX(prev.start.getTime()) < 4) ? tX(prev.start.getTime()) + 10 : px2
      if (x1 > prevR + 3) { row.push(ev); placed = true; break }
    }
    if (!placed) rows.push([ev])
  }
  return rows
}

// ── Palette system ────────────────────────────────────────────────────────────

const lightenHex = (hex, amount = 0.88) => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  const lr = Math.round(r + (255 - r) * amount)
  const lg = Math.round(g + (255 - g) * amount)
  const lb = Math.round(b + (255 - b) * amount)
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`
}

const COLOUR_NAMES = {
  red: '#d32f2f', blue: '#1565c0', green: '#2e7d32',
  orange: '#e65100', purple: '#6a1b9a', teal: '#00695c',
  pink: '#c2185b', yellow: '#f9a825', brown: '#4e342e',
  grey: '#546e7a', gray: '#546e7a', indigo: '#283593',
  cyan: '#00838f', lime: '#558b2f', amber: '#ff6f00',
  navy: '#1a237e', rose: '#ad1457', violet: '#4527a0',
}

const colourToEntry = c => {
  const hex = c.startsWith('#') ? c : (COLOUR_NAMES[c.toLowerCase()] || '#888888')
  return { bar: hex, bg: lightenHex(hex), stripe: hex }
}

export const NAMED_PALETTES = {
  default: [
    { bar: '#3d6fb5', bg: '#f2f5fb', stripe: '#3d6fb5' },
    { bar: '#b54040', bg: '#fbf2f2', stripe: '#b54040' },
    { bar: '#3a9455', bg: '#f2fbf5', stripe: '#3a9455' },
    { bar: '#8f7535', bg: '#fbf8f2', stripe: '#8f7535' },
    { bar: '#6d3db5', bg: '#f5f2fb', stripe: '#6d3db5' },
    { bar: '#348f99', bg: '#f2f8fb', stripe: '#348f99' },
  ],
  warm: [
    { bar: '#c0392b', bg: '#fdf2f1', stripe: '#c0392b' },
    { bar: '#e67e22', bg: '#fef9f0', stripe: '#e67e22' },
    { bar: '#f39c12', bg: '#fefdf0', stripe: '#f39c12' },
    { bar: '#d35400', bg: '#fdf5f0', stripe: '#d35400' },
    { bar: '#922b21', bg: '#fdf0ef', stripe: '#922b21' },
    { bar: '#cb4335', bg: '#fdf2f1', stripe: '#cb4335' },
  ],
  cool: [
    { bar: '#2471a3', bg: '#eaf4fb', stripe: '#2471a3' },
    { bar: '#148f77', bg: '#e8f8f5', stripe: '#148f77' },
    { bar: '#1a5276', bg: '#e8f4f8', stripe: '#1a5276' },
    { bar: '#6c3483', bg: '#f4ecf7', stripe: '#6c3483' },
    { bar: '#0e6655', bg: '#e8f8f5', stripe: '#0e6655' },
    { bar: '#1f618d', bg: '#e9f2f9', stripe: '#1f618d' },
  ],
  earth: [
    { bar: '#795548', bg: '#f4efee', stripe: '#795548' },
    { bar: '#558b2f', bg: '#f1f8e9', stripe: '#558b2f' },
    { bar: '#6d4c41', bg: '#f3eeec', stripe: '#6d4c41' },
    { bar: '#827717', bg: '#f9f8e7', stripe: '#827717' },
    { bar: '#4e342e', bg: '#f2e9e8', stripe: '#4e342e' },
    { bar: '#33691e', bg: '#f1f8e9', stripe: '#33691e' },
  ],
  mono: [
    { bar: '#37474f', bg: '#f4f5f6', stripe: '#37474f' },
    { bar: '#546e7a', bg: '#f5f6f7', stripe: '#546e7a' },
    { bar: '#607d8b', bg: '#f6f7f8', stripe: '#607d8b' },
    { bar: '#263238', bg: '#f3f4f5', stripe: '#263238' },
    { bar: '#455a64', bg: '#f4f5f6', stripe: '#455a64' },
    { bar: '#78909c', bg: '#f6f7f8', stripe: '#78909c' },
  ],
  neon: [
    { bar: '#e040fb', bg: '#fce4ff', stripe: '#e040fb' },
    { bar: '#00bcd4', bg: '#e0f7fa', stripe: '#00bcd4' },
    { bar: '#00e676', bg: '#e0fff0', stripe: '#00e676' },
    { bar: '#ff6d00', bg: '#fff3e0', stripe: '#ff6d00' },
    { bar: '#ff1744', bg: '#ffe8ea', stripe: '#ff1744' },
    { bar: '#ffd740', bg: '#fffde7', stripe: '#ffd740' },
  ],
}

export const renderSVG = (events, opts = {}) => {
  const W = opts.width || 420

  if (!events.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="48" viewBox="0 0 ${W} 48" style="font-family:sans-serif">` +
           `<text x="${W/2}" y="28" text-anchor="middle" font-size="12" fill="#bbb">no events</text></svg>`
  }

  // ── Time bounds ────────────────────────────────────────────────────────────
  let minT = Infinity, maxT = -Infinity
  for (const ev of events) {
    minT = Math.min(minT, ev.start.getTime())
    maxT = Math.max(maxT, ev.end.getTime())
  }
  const spanMs = maxT - minT || 86400000
  minT -= spanMs * 0.04
  maxT += spanMs * 0.04

  // ── Sections ───────────────────────────────────────────────────────────────
  const secMap = new Map()
  for (const ev of events) {
    const k = ev.group ?? '\0'
    if (!secMap.has(k)) secMap.set(k, { name: ev.group ?? null, events: [] })
    secMap.get(k).events.push(ev)
  }
  const sections = [...secMap.values()]
  const hasNames = sections.some(s => s.name !== null)

  // ── Layout constants ───────────────────────────────────────────────────────
  const PAD     = { top: 20, right: 14, bottom: 6, left: 12 }
  const ROW_H   = 26        // height per packed event row
  const BAR_H   = 14        // filled bar height
  const SEC_LBL = hasNames ? 20 : 0   // section name row
  const SEC_GAP = hasNames ? 5 : 3    // gap between sections
  const AXIS_H  = 26        // axis line + ticks + tick labels

  const plotX1 = PAD.left
  const plotX2 = W - PAD.right
  const plotW  = plotX2 - plotX1
  const tX     = t => plotX1 + (t - minT) / (maxT - minT) * plotW

  // ── Pre-compute rows per section ──────────────────────────────────────────
  const layouts = sections.map(sec => ({ ...sec, rows: packRows(sec.events, tX) }))
  const secH    = l => SEC_LBL + l.rows.length * ROW_H + SEC_GAP

  const totalContent = layouts.reduce((s, l) => s + secH(l), 0)
  const axisY        = PAD.top + totalContent
  const H            = axisY + AXIS_H + PAD.bottom

  const ticks = generateTicks(minT, maxT)

  // ── Build SVG ─────────────────────────────────────────────────────────────
  const o = []
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="font-family:sans-serif;display:block">`)
  o.push(`<style>
    .tl-ev { cursor:pointer }
    .tl-bar rect { transition:opacity .1s }
    .tl-bar:hover rect { opacity:1 !important }
    .tl-pt:hover .tl-dot { r:6 }
  </style>`)

  // Vertical grid lines at major ticks (drawn behind everything)
  for (const tk of ticks) {
    if (!tk.major) continue
    const x = tX(tk.t)
    if (x <= plotX1 || x >= plotX2) continue
    o.push(`<line x1="${r2(x)}" y1="${PAD.top}" x2="${r2(x)}" y2="${axisY}" stroke="#ebebeb" stroke-width="1"/>`)
  }

  // ── Sections ───────────────────────────────────────────────────────────────
  let sY = PAD.top

  layouts.forEach((sl, si) => {
    const activePalette = opts.palette || NAMED_PALETTES.default
    const col = activePalette[si % activePalette.length]
    const bH  = secH(sl) - SEC_GAP   // band height (excluding gap)

    if (hasNames) {
      // Background band
      o.push(`<rect x="${plotX1}" y="${sY}" width="${plotW}" height="${bH}" fill="${col.bg}" rx="2"/>`)
      // Left accent stripe
      o.push(`<rect x="${plotX1}" y="${sY}" width="3" height="${bH}" fill="${col.stripe}" rx="1"/>`)
      // Section label — anchored near top of band, not 4px before evTop
      if (sl.name) {
        o.push(`<text x="${plotX1 + 7}" y="${sY + 11}" font-size="10" font-weight="600" fill="${col.stripe}">${escXML(sl.name)}</text>`)
      }
    }

    const evTop = sY + SEC_LBL  // y where event rows start

    sl.rows.forEach((row, ri) => {
      const midY = evTop + ri * ROW_H + ROW_H / 2

      row.forEach((ev, ei) => {
        const x1 = r2(tX(ev.start.getTime()))
        const x2 = r2(tX(ev.end.getTime()))
        const isPoint = (x2 - x1) < 4

        if (isPoint) {
          // Alternate label height between two levels above the circle.
          // Base offset clears a same-row pill (top at midY-7) with breathing room.
          const lblY = midY - ((ei + ri) % 2 === 0 ? 12 : 21)
          // Clamp label so it doesn't overflow the plot edges (6.2px per char estimate)
          const halfW = (ev.label ? ev.label.length * 6.2 / 2 : 0)
          let lblX = x1, anchor = 'middle'
          if (x1 - halfW < plotX1 + 2) { lblX = Math.max(x1, plotX1 + 2); anchor = 'start' }
          else if (x1 + halfW > plotX2 - 2) { lblX = Math.min(x1, plotX2 - 2); anchor = 'end' }
          o.push(
            `<g class="tl-pt tl-ev timeline-event" data-label="${escAttr(ev.label)}"${fedwikiAttrs(ev.label)}>` +
            `<rect x="${x1 - 10}" y="${midY - 10}" width="20" height="20" fill="transparent"/>` +
            `<circle class="tl-dot" cx="${x1}" cy="${midY}" r="5" fill="${col.bar}" stroke="#fff" stroke-width="1.5"/>` +
            (ev.label ? `<text x="${r2(lblX)}" y="${lblY}" text-anchor="${anchor}" font-size="10" fill="${col.bar}" style="pointer-events:none">${escXML(ev.label)}</text>` : '') +
            `<title>${escXML(ev.label || '')}: ${fmtDate(ev.start)}</title>` +
            `</g>`
          )
        } else {
          const barW = Math.max(x2 - x1, 3)
          const barY = r2(midY - BAR_H / 2)
          const inside = barW > 52
          o.push(
            `<g class="tl-bar tl-ev timeline-event" data-label="${escAttr(ev.label)}"${fedwikiAttrs(ev.label)}>` +
            `<rect x="${x1}" y="${barY}" width="${r2(barW)}" height="${BAR_H}" fill="${col.bar}" opacity=".82" rx="3"/>` +
            (inside ? `<text x="${x1 + 5}" y="${barY + BAR_H - 4}" font-size="10" fill="#fff" style="pointer-events:none">${escXML(clipText(ev.label, barW - 10))}</text>` : '') +
            `<title>${escXML(ev.label || '')}: ${fmtDate(ev.start)}–${fmtDate(ev.end)}</title>` +
            `</g>`
          )
        }
      })
    })

    sY += secH(sl)
  })

  // ── Time axis ──────────────────────────────────────────────────────────────
  o.push(`<line x1="${plotX1}" y1="${axisY}" x2="${plotX2}" y2="${axisY}" stroke="#ccc" stroke-width="1.5"/>`)

  for (const tk of ticks) {
    const x = tX(tk.t)
    if (x < plotX1 || x > plotX2) continue
    o.push(`<line x1="${r2(x)}" y1="${axisY}" x2="${r2(x)}" y2="${axisY + (tk.major ? 5 : 3)}" stroke="${tk.major ? '#bbb' : '#ddd'}" stroke-width="1"/>`)
    if (tk.label) {
      o.push(`<text x="${r2(x)}" y="${axisY + 18}" text-anchor="middle" font-size="10" fill="#999">${tk.label}</text>`)
    }
  }

  o.push(`</svg>`)
  return o.join('\n')
}

// ── Freeze serialiser ─────────────────────────────────────────────────────────
// Converts an array of event objects back to DSL text.
// Preserves PALETTE directive from the original text; strips LINEUP keyword.
// Groups events into `section` blocks when group names are present.

const pad2date = n => String(n).padStart(2, '0')
const fmtISO = d => `${d.getFullYear()}-${pad2date(d.getMonth()+1)}-${pad2date(d.getDate())}`

export const eventsToText = (events, originalText) => {
  const lines = []

  // Preserve any PALETTE directive from the original text
  for (const raw of (originalText || '').split('\n')) {
    if (/^PALETTE\s/i.test(raw.trim())) lines.push(raw.trim())
  }

  // Group events by their section / group
  const secMap = new Map()
  for (const ev of events) {
    const k = ev.group ?? '\0'
    if (!secMap.has(k)) secMap.set(k, { name: ev.group ?? null, events: [] })
    secMap.get(k).events.push(ev)
  }

  for (const { name, events: evs } of secMap.values()) {
    if (name) lines.push(`section ${name}`)
    for (const ev of evs) {
      const isPoint = ev.start.getTime() === ev.end.getTime()
      const dateStr = isPoint
        ? fmtISO(ev.start)
        : `${fmtISO(ev.start)}..${fmtISO(ev.end)}`
      const labelPart = ev.label ? ` ${ev.label}` : ''
      lines.push(`${dateStr}${labelPart}`)
    }
  }

  return lines.join('\n')
}

// ── Controls helpers ──────────────────────────────────────────────────────────

// SVG expand icon (12×12)
const EXPAND_ICON =
  `<svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor" style="display:block">` +
  `<path d="M0 0h4v1.5H1.5V4H0V0zm8 0h4v4h-1.5V1.5H8V0zM0 8h1.5v2.5H4V12H0V8zm9.5 2.5V8H11v4H7v-1.5h2.5z"/>` +
  `</svg>`

const mkControls = () => {
  const sTitle = 'Freeze — capture LINEUP events into item text so they persist (double-click to edit; restore LINEUP to thaw)'
  const eTitle = 'Open fullscreen in new tab'
  return (
    `<div class="tl-controls">` +
    `<span class="tl-btn tl-save" title="${sTitle}">❄</span>` +
    `<span class="tl-btn tl-expand" title="${eTitle}">${EXPAND_ICON}</span>` +
    `</div>`
  )
}

const TL_CSS = `<style id="wiki-tl-styles">
.wiki-plugin-timeline { overflow: hidden }
.tl-controls {
  display: flex; justify-content: flex-end; gap: 3px;
  padding: 3px 2px 1px; margin-top: 3px;
  border-top: 1px solid #f0f0f0;
}
.tl-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 4px;
  cursor: pointer; color: #aaa; font-size: 15px; line-height: 1;
  transition: background .1s, color .1s;
}
.tl-btn:hover { background: #f0f0f0; color: #555 }
.tl-saved { color: #3a9455 !important }
</style>`

let tlCSSInjected = false
const injectTLCSS = () => {
  if (tlCSSInjected || document.getElementById('wiki-tl-styles')) return
  document.head.insertAdjacentHTML('beforeend', TL_CSS)
  tlCSSInjected = true
}

// ── emit ──────────────────────────────────────────────────────────────────────

export const emit = ($item, item) => {
  if (typeof document !== 'undefined') injectTLCSS()
  const { events, palette } = parseText(item.text)
  $item.html(
    `<div class="wiki-plugin-timeline">` +
    renderSVG(events, { palette }) +
    mkControls() +
    `</div>`
  )
}

// ── bind ──────────────────────────────────────────────────────────────────────

export const bind = ($item, item) => {
  injectTLCSS()
  const { events: authoredEvents, palette } = parseText(item.text)
  const events = collect($item, item, authoredEvents)

  $item.find('.wiki-plugin-timeline').html(
    renderSVG(events, { palette }) +
    mkControls()
  )

  // ── Navigation — click on any .timeline-event ──────────────────────────────
  $item.find('svg').on('click', '.timeline-event', function (e) {
    const label = this.dataset.label
    if (!label) return
    try {
      wiki.pageHandler.context = wiki.lineup.atKey($item.closest('.page').data('key')).getContext()
      wiki.doInternalLink(label, e.shiftKey ? null : $item.closest('.page'))
    } catch (_) {}
  })

  // ── Freeze — capture lineup events into item text, save the item ─────────────
  // Serialises all current events (including any LINEUP-sourced ones) back into
  // the item's DSL text and saves via pageHandler.put. The resulting text is
  // fully editable: add `PALETTE warm`, tweak dates, or restore `LINEUP` to thaw.
  $item.find('.tl-save').on('click', function () {
    const btn = this
    try {
      const frozenText = eventsToText(events, item.text)
      const $page      = $item.closest('.page')
      const updatedItem = { ...item, text: frozenText }
      wiki.pageHandler.put($page, { type: 'edit', id: item.id, item: updatedItem })
      // Update in-memory item so a second freeze works without re-bind
      item.text = frozenText
      btn.classList.add('tl-saved')
      setTimeout(() => btn.classList.remove('tl-saved'), 1600)
    } catch (err) {
      console.error('[timeline] freeze failed', err)
    }
  })

  // ── Fullscreen — opens in a new browser tab ────────────────────────────────
  let dialogTab = null

  $item.find('.tl-expand').on('click', () => {
    const $page  = $item.closest('.page')
    const pageKey = $page.data('key')
    let context
    try { context = wiki.lineup.atKey(pageKey).getContext() } catch (_) { context = [] }

    const svgFull = renderSVG(events, { width: 1200, palette })
    const send = () => dialogTab?.postMessage({ svg: svgFull, pageKey, context }, '*')

    dialogTab = window.open('/plugins/timeline/dialog/', '_blank')
    if (!dialogTab) return

    // Deliver SVG: via load event (same-origin) + timeout fallback
    dialogTab.addEventListener('load', send, { once: true })
    setTimeout(send, 1000)
  })

  // ── Edit — dblclick anywhere outside the SVG ──────────────────────────────
  $item.on('dblclick', e => {
    if ($(e.target).closest('svg').length) return
    wiki.textEditor($item, item)
  })

  // ── Messages from the fullscreen tab ─────────────────────────────────────
  const $page = $item.closest('.page')
  const pageKey = $page.data('key')

  const onMessage = e => {
    // Dialog tab signals it is ready — resend SVG (handles tab-loaded-before-send race)
    if (e.data?.action === 'ready') {
      let ctx
      try { ctx = wiki.lineup.atKey(pageKey).getContext() } catch (_) { ctx = [] }
      const svgFull = renderSVG(events, { width: 1200, palette })
      dialogTab?.postMessage({ svg: svgFull, pageKey, context: ctx }, '*')
      return
    }
    if (e.data?.action !== 'doInternalLink') return
    try {
      wiki.pageHandler.context = e.data.context || []
      wiki.doInternalLink(e.data.title, e.data.keepLineup ? $item.closest('.page') : null)
    } catch (_) {}
  }
  window.addEventListener('message', onMessage)
  $item.one('remove', () => window.removeEventListener('message', onMessage))
}

// ── Register ──────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined' && window !== null) {
  window.plugins = window.plugins || {}
  window.plugins.timeline = { emit, bind }
}
