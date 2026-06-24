// wiki-plugin-timeline
// Renders a navigable SVG timeline from:
//   - Events authored directly in the item DSL
//   - Date Plugin items upstream in the lineup (when LINEUP keyword present)
//   - Frozen lineup snapshots (item.frozen)

// ── Parser ────────────────────────────────────────────────────────────────────
// DSL (Mermaid gantt-inspired):
//
//   LINEUP                              ← enable lineup scanning
//   section GroupName                  ← start a named group
//   2026-01-15 Event Label             ← point event
//   2026-02-01..2026-05-30 Event Label ← range event
//   2026-02-01 Event #GroupName        ← inline group tag

const parseISO = str => {
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null
}

export const parseText = text => {
  const lines   = (text || '').split(/\n/)
  let lineup    = false
  let section   = null
  const events  = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('//')) continue

    if (line === 'LINEUP') { lineup = true; continue }

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

  return { lineup, events }
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
  if (item.frozen) {
    return [...item.frozen, ...authoredEvents]
  }

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

const PALETTE = [
  { bar: '#3d6fb5', bg: '#f2f5fb', stripe: '#3d6fb5' },
  { bar: '#b54040', bg: '#fbf2f2', stripe: '#b54040' },
  { bar: '#3a9455', bg: '#f2fbf5', stripe: '#3a9455' },
  { bar: '#8f7535', bg: '#fbf8f2', stripe: '#8f7535' },
  { bar: '#6d3db5', bg: '#f5f2fb', stripe: '#6d3db5' },
  { bar: '#348f99', bg: '#f2f8fb', stripe: '#348f99' },
]

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
  const ROW_H   = 22        // height per packed event row
  const BAR_H   = 14        // filled bar height
  const SEC_LBL = hasNames ? 16 : 0   // section name row
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
    const col = PALETTE[si % PALETTE.length]
    const bH  = secH(sl) - SEC_GAP   // band height (excluding gap)

    if (hasNames) {
      // Background band
      o.push(`<rect x="${plotX1}" y="${sY}" width="${plotW}" height="${bH}" fill="${col.bg}" rx="2"/>`)
      // Left accent stripe
      o.push(`<rect x="${plotX1}" y="${sY}" width="3" height="${bH}" fill="${col.stripe}" rx="1"/>`)
      // Section label
      if (sl.name) {
        o.push(`<text x="${plotX1 + 7}" y="${sY + SEC_LBL - 4}" font-size="10" font-weight="600" fill="${col.stripe}">${escXML(sl.name)}</text>`)
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
          // Alternate label height between two levels above the circle
          const lblY = midY - ((ei + ri) % 2 === 0 ? 9 : 18)
          o.push(
            `<g class="tl-pt tl-ev timeline-event" data-label="${escAttr(ev.label)}">` +
            `<rect x="${x1 - 10}" y="${midY - 10}" width="20" height="20" fill="transparent"/>` +
            `<circle class="tl-dot" cx="${x1}" cy="${midY}" r="5" fill="${col.bar}" stroke="#fff" stroke-width="1.5"/>` +
            (ev.label ? `<text x="${x1}" y="${lblY}" text-anchor="middle" font-size="10" fill="${col.bar}" style="pointer-events:none">${escXML(ev.label)}</text>` : '') +
            `<title>${escXML(ev.label || '')}: ${fmtDate(ev.start)}</title>` +
            `</g>`
          )
        } else {
          const barW = Math.max(x2 - x1, 3)
          const barY = r2(midY - BAR_H / 2)
          const inside = barW > 52
          o.push(
            `<g class="tl-bar tl-ev timeline-event" data-label="${escAttr(ev.label)}">` +
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

// ── Controls helpers ──────────────────────────────────────────────────────────

// SVG expand icon (12×12)
const EXPAND_ICON =
  `<svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor" style="display:block">` +
  `<path d="M0 0h4v1.5H1.5V4H0V0zm8 0h4v4h-1.5V1.5H8V0zM0 8h1.5v2.5H4V12H0V8zm9.5 2.5V8H11v4H7v-1.5h2.5z"/>` +
  `</svg>`

const mkControls = (frozen) => {
  const fTitle = frozen ? 'Thaw — shift-click to restore live updates' : 'Freeze lineup events into this item'
  const eTitle = 'Open fullscreen in new tab'
  return (
    `<div class="tl-controls">` +
    `<span class="tl-btn tl-freeze${frozen ? ' tl-frozen' : ''}" title="${fTitle}">❄</span>` +
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
.tl-frozen { color: #3d6fb5 !important }
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
  const { events: authoredEvents } = parseText(item.text)
  const events = item.frozen
    ? [...(item.frozen || []).map(normaliseStoredEvent), ...authoredEvents]
    : authoredEvents

  $item.html(
    `<div class="wiki-plugin-timeline">` +
    renderSVG(events) +
    mkControls(!!item.frozen) +
    `</div>`
  )
}

const normaliseStoredEvent = ev => ({
  label: ev.label || '',
  start: new Date(ev.start),
  end:   new Date(ev.end || ev.start),
  group: ev.group || null,
})

// ── bind ──────────────────────────────────────────────────────────────────────

export const bind = ($item, item) => {
  injectTLCSS()
  const { events: authoredEvents } = parseText(item.text)
  const events = collect($item, item, authoredEvents)

  $item.find('.wiki-plugin-timeline').html(
    renderSVG(events) +
    mkControls(!!item.frozen)
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

  // ── Freeze / Thaw ──────────────────────────────────────────────────────────
  $item.find('.tl-freeze').on('click', function (e) {
    if (e.shiftKey && item.frozen) {
      delete item.frozen
      delete item.svg
    } else if (!item.frozen) {
      const { events: authored } = parseText(item.text)
      const allEvents = collect($item, item, authored)
      item.frozen = allEvents.filter(ev => !authored.includes(ev)).map(ev => ({
        label: ev.label,
        start: ev.start.toISOString(),
        end:   ev.end.toISOString(),
        group: ev.group,
      }))
    } else {
      return
    }
    try {
      const $page = $item.closest('.page')
      wiki.pageHandler.put($page, { type: 'edit', id: item.id, item })
      wiki.doPlugin($item.empty(), item)
    } catch (_) {}
  })

  // ── Fullscreen — opens in a new browser tab ────────────────────────────────
  let dialogTab = null

  $item.find('.tl-expand').on('click', () => {
    const $page  = $item.closest('.page')
    const pageKey = $page.data('key')
    let context
    try { context = wiki.lineup.atKey(pageKey).getContext() } catch (_) { context = [] }

    const svgFull = renderSVG(events, { width: 1200 })
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
      const svgFull = renderSVG(events, { width: 1200 })
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
