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
// Width is fixed at 400px (wiki column). Height scales with number of lanes.

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const pad2 = n => String(n).padStart(2, '0')
const fmtDate = d => `${pad2(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`

export const renderSVG = (events, opts = {}) => {
  const W       = opts.width  || 400
  const PADDING = { top: 28, right: 12, bottom: 16, left: 8 }
  const ROW_H   = 22
  const TICK_H  = 14

  if (!events.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="48" viewBox="0 0 ${W} 48">` +
           `<text x="${W/2}" y="28" text-anchor="middle" font-size="12" fill="#999">no events</text></svg>`
  }

  // Time bounds
  let minT = Infinity, maxT = -Infinity
  for (const ev of events) {
    minT = Math.min(minT, ev.start.getTime())
    maxT = Math.max(maxT, ev.end.getTime())
  }
  // Pad edges 3%
  const span = maxT - minT || 86400000
  minT -= span * 0.03
  maxT += span * 0.03

  const plotW = W - PADDING.left - PADDING.right
  const tX = t => PADDING.left + (t - minT) / (maxT - minT) * plotW

  // Group events into lanes by group name (null → 'Events')
  const laneMap = new Map()
  for (const ev of events) {
    const key = ev.group || ''
    if (!laneMap.has(key)) laneMap.set(key, [])
    laneMap.get(key).push(ev)
  }

  const lanes = [...laneMap.entries()]
  const H = PADDING.top + lanes.length * ROW_H + TICK_H + PADDING.bottom

  const lines = []
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`)
  lines.push(`<style>
    .tl-axis { stroke: #ccc; stroke-width: 1; }
    .tl-tick { stroke: #ccc; stroke-width: 1; }
    .tl-tick-label { font: 10px sans-serif; fill: #999; }
    .tl-lane-label { font: 10px sans-serif; fill: #888; }
    .tl-bar { rx: 3; ry: 3; cursor: pointer; }
    .tl-bar:hover rect { opacity: .8; }
    .tl-bar text { font: 11px sans-serif; fill: #fff; pointer-events: none; }
    .tl-point { cursor: pointer; }
    .tl-point:hover circle { r: 5.5; }
    .tl-point text { font: 11px sans-serif; fill: #334; pointer-events: none; }
  </style>`)

  // Axis line
  const axisY = PADDING.top + lanes.length * ROW_H
  lines.push(`<line class="tl-axis" x1="${PADDING.left}" y1="${axisY}" x2="${W - PADDING.right}" y2="${axisY}"/>`)

  // Year ticks
  const startYear = new Date(minT).getFullYear()
  const endYear   = new Date(maxT).getFullYear()
  for (let y = startYear; y <= endYear + 1; y++) {
    const t = new Date(y, 0, 1).getTime()
    if (t < minT || t > maxT) continue
    const x = tX(t)
    lines.push(`<line class="tl-tick" x1="${x}" y1="${axisY}" x2="${x}" y2="${axisY + 5}"/>`)
    lines.push(`<text class="tl-tick-label" x="${x}" y="${axisY + TICK_H}">${y}</text>`)
  }

  // Lane labels + events
  const COLORS = ['#5b8dd9','#d96b5b','#5bc47a','#c4a45b','#9b5bd9','#5bd9c4']

  lanes.forEach(([group, evs], laneIdx) => {
    const laneY   = PADDING.top + laneIdx * ROW_H
    const midY    = laneY + ROW_H / 2
    const color   = COLORS[laneIdx % COLORS.length]
    const barH    = ROW_H - 6

    if (group) {
      lines.push(`<text class="tl-lane-label" x="${PADDING.left}" y="${midY + 4}">${escXML(group)}</text>`)
    }

    for (const ev of evs) {
      const x1 = tX(ev.start.getTime())
      const x2 = tX(ev.end.getTime())
      const isPoint = (x2 - x1) < 3

      if (isPoint) {
        // Point event — circle + label to the right
        lines.push(
          `<g class="tl-point timeline-event" data-label="${escAttr(ev.label)}">` +
          `<circle cx="${x1}" cy="${midY}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>` +
          `<text x="${x1 + 7}" y="${midY + 4}">${escXML(ev.label)}</text>` +
          `</g>`
        )
      } else {
        // Range event — bar with clipped label
        const barW = Math.max(x2 - x1, 4)
        lines.push(
          `<g class="tl-bar timeline-event" data-label="${escAttr(ev.label)}">` +
          `<rect x="${x1}" y="${midY - barH/2}" width="${barW}" height="${barH}" fill="${color}" opacity=".85" rx="3" ry="3"/>` +
          (barW > 40 ? `<text x="${x1 + 4}" y="${midY + 4}" clip-path="inset(0 0 0 0)">${escXML(ev.label)}</text>` : '') +
          `<title>${escXML(ev.label)}: ${fmtDate(ev.start)}–${fmtDate(ev.end)}</title>` +
          `</g>`
        )
      }
    }
  })

  lines.push(`</svg>`)
  return lines.join('\n')
}

const escXML  = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
const escAttr = s => (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')

// ── emit ──────────────────────────────────────────────────────────────────────

export const emit = ($item, item) => {
  const { events: authoredEvents } = parseText(item.text)
  const events = item.frozen
    ? [...(item.frozen || []).map(normaliseStoredEvent), ...authoredEvents]
    : authoredEvents

  const svg = renderSVG(events)
  $item.html(
    `<div class="wiki-plugin-timeline" style="overflow:hidden;">` +
    svg +
    `<div class="tl-controls" style="text-align:right;font-size:11px;color:#aaa;margin-top:2px;">` +
    `<span class="tl-freeze" title="Freeze lineup events" style="cursor:pointer;margin-right:6px;">❄</span>` +
    `<span class="tl-expand" title="Fullscreen" style="cursor:pointer;">⤢</span>` +
    `</div></div>`
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
  const { events: authoredEvents } = parseText(item.text)

  // Re-collect (will use frozen if present, else scan lineup)
  const events = collect($item, item, authoredEvents)

  // Render with live events
  const svg = renderSVG(events)
  $item.find('.wiki-plugin-timeline').html(
    svg +
    `<div class="tl-controls" style="text-align:right;font-size:11px;color:#aaa;margin-top:2px;">` +
    `<span class="tl-freeze" title="${item.frozen ? 'Thaw (shift-click to restore live)' : 'Freeze lineup events'}" ` +
    `style="cursor:pointer;margin-right:6px;${item.frozen ? 'color:#5b8dd9' : ''}">❄</span>` +
    `<span class="tl-expand" title="Fullscreen" style="cursor:pointer;">⤢</span>` +
    `</div>`
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

  // ── Freeze ─────────────────────────────────────────────────────────────────
  $item.find('.tl-freeze').on('click', function (e) {
    if (e.shiftKey && item.frozen) {
      // Thaw
      delete item.frozen
      delete item.svg
    } else if (!item.frozen) {
      // Freeze current lineup events (not authored events)
      const { events: authored } = parseText(item.text)
      const allEvents = collect($item, item, authored)
      // Only freeze the non-authored (lineup-sourced) events
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

  // ── Fullscreen dialog ──────────────────────────────────────────────────────
  $item.find('.tl-expand').on('click', () => {
    const $page  = $item.closest('.page')
    const pageKey = $page.data('key')
    let context
    try { context = wiki.lineup.atKey(pageKey).getContext() } catch (_) { context = [] }

    const win = window.open(
      '/plugins/timeline/dialog/',
      'wiki-timeline-dialog-' + pageKey,
      'popup,width=900,height=600'
    )
    if (!win) return

    const svgFull = renderSVG(events, { width: 860 })
    const send = () => win.postMessage({ svg: svgFull, pageKey, context }, '*')
    // Send once loaded, then again after a short delay in case it wasn't ready
    win.addEventListener('load', send, { once: true })
    setTimeout(send, 800)
  })

  // ── Listen for navigation messages from the dialog ─────────────────────────
  const onMessage = e => {
    if (e.data?.action !== 'doInternalLink') return
    try {
      wiki.pageHandler.context = e.data.context || []
      wiki.doInternalLink(e.data.title, e.data.keepLineup ? $item.closest('.page') : null)
    } catch (_) {}
  }
  window.addEventListener('message', onMessage)
  // Clean up when item is removed from DOM
  $item.one('remove', () => window.removeEventListener('message', onMessage))
}

// ── Register ──────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined' && window !== null) {
  window.plugins = window.plugins || {}
  window.plugins.timeline = { emit, bind }
}
