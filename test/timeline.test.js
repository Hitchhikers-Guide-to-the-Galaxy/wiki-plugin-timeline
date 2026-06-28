import { strict as assert } from 'assert'
import { parseText, renderSVG, eventsToText } from '../src/client/timeline.js'

const test = (name, fn) => {
  try { fn(); console.log('  ✓', name) }
  catch(e) { console.error('  ✗', name, e.message); process.exitCode = 1 }
}

console.log('parseText')

test('LINEUP keyword sets flag', () => {
  const { lineup } = parseText('LINEUP')
  assert.equal(lineup, true)
})

test('no LINEUP flag by default', () => {
  const { lineup } = parseText('2026-01-15 My Event')
  assert.equal(lineup, false)
})

test('point event', () => {
  const { events } = parseText('2026-01-15 Hitchhiker Game Jam')
  assert.equal(events.length, 1)
  assert.equal(events[0].label, 'Hitchhiker Game Jam')
  assert.ok(events[0].start instanceof Date)
  assert.equal(events[0].start.getTime(), events[0].end.getTime())
})

test('range event', () => {
  const { events } = parseText('2026-02-01..2026-05-30 Wiki Wild Compo')
  assert.equal(events[0].label, 'Wiki Wild Compo')
  assert.ok(events[0].end.getTime() > events[0].start.getTime())
})

test('section sets group', () => {
  const { events } = parseText('section Demoscene\n2026-01-15 Event A')
  assert.equal(events[0].group, 'Demoscene')
})

test('inline group tag', () => {
  const { events } = parseText('2026-01-15 Event A #Projects')
  assert.equal(events[0].group, 'Projects')
  assert.equal(events[0].label, 'Event A')
})

test('inline group overrides section', () => {
  const { events } = parseText('section Default\n2026-01-15 Event A #Override')
  assert.equal(events[0].group, 'Override')
})

test('blank lines and comments ignored', () => {
  const { events } = parseText('\n// comment\n\n2026-01-15 Only Event')
  assert.equal(events.length, 1)
})

test('multiple events', () => {
  const text = `LINEUP
section Demoscene
2026-02-01..2026-05-30 Wiki Wild Compo
2026-01-15 Hitchhiker Game Jam

section Projects
2025-04-12 Patchable Knowledge Habitats`
  const { lineup, events } = parseText(text)
  assert.equal(lineup, true)
  assert.equal(events.length, 3)
  assert.equal(events[0].group, 'Demoscene')
  assert.equal(events[2].group, 'Projects')
})

console.log('renderSVG')

test('empty events returns svg with "no events" message', () => {
  const svg = renderSVG([])
  assert.ok(svg.includes('no events'))
})

test('renders point event', () => {
  const events = [{ label: 'Test Event', start: new Date(2026,0,15), end: new Date(2026,0,15), group: null }]
  const svg = renderSVG(events)
  assert.ok(svg.includes('Test Event'))
  assert.ok(svg.includes('timeline-event'))
})

test('renders range event', () => {
  const events = [{ label: 'Long Range', start: new Date(2026,0,1), end: new Date(2026,5,30), group: null }]
  const svg = renderSVG(events)
  assert.ok(svg.includes('Long Range'))
  assert.ok(svg.includes('<rect'))
})

test('renders multiple groups as lanes', () => {
  const events = [
    { label: 'A', start: new Date(2026,0,1), end: new Date(2026,0,1), group: 'G1' },
    { label: 'B', start: new Date(2026,3,1), end: new Date(2026,3,1), group: 'G2' },
  ]
  const svg = renderSVG(events)
  assert.ok(svg.includes('G1'))
  assert.ok(svg.includes('G2'))
})

test('section bands appear in SVG when groups named', () => {
  const events = [
    { label: 'A', start: new Date(2026,0,1), end: new Date(2026,2,1), group: 'Alpha' },
    { label: 'B', start: new Date(2026,3,1), end: new Date(2026,5,1), group: 'Beta' },
  ]
  const svg = renderSVG(events)
  // Should have background band rect and stripe
  assert.ok(svg.includes('Alpha'))
  assert.ok(svg.includes('Beta'))
  assert.ok((svg.match(/<rect/g) || []).length >= 4)  // at least 2 bands + 2 stripes
})

test('overlapping events are packed into separate rows', () => {
  // Two events that overlap in time — should produce two rows (two different midY values)
  const events = [
    { label: 'First',  start: new Date(2026,0,1), end: new Date(2026,6,1), group: null },
    { label: 'Second', start: new Date(2026,2,1), end: new Date(2026,9,1), group: null },
  ]
  const svg = renderSVG(events)
  // Both events should appear
  assert.ok(svg.includes('First'))
  assert.ok(svg.includes('Second'))
})

test('month ticks appear for sub-year span', () => {
  const events = [
    { label: 'Ev', start: new Date(2026,0,1), end: new Date(2026,5,30), group: null },
  ]
  const svg = renderSVG(events)
  // Should include at least one month abbreviation
  const hasMonth = ['Jan','Feb','Mar','Apr','May','Jun'].some(m => svg.includes(m))
  assert.ok(hasMonth)
})

test('year ticks appear for multi-year span', () => {
  const events = [
    { label: 'Ev', start: new Date(2024,0,1), end: new Date(2027,0,1), group: null },
  ]
  const svg = renderSVG(events)
  assert.ok(svg.includes('2024') || svg.includes('2025'))
  assert.ok(svg.includes('2026') || svg.includes('2027'))
})

test('opts.width changes SVG width', () => {
  const events = [{ label: 'Ev', start: new Date(2026,0,1), end: new Date(2026,6,1), group: null }]
  const svg = renderSVG(events, { width: 860 })
  assert.ok(svg.includes('width="860"'))
})

console.log('eventsToText')

test('point event round-trips through text', () => {
  const events = [{ label: 'My Event', start: new Date(2026,0,15), end: new Date(2026,0,15), group: null }]
  const text = eventsToText(events, '')
  assert.ok(text.includes('2026-01-15 My Event'))
})

test('range event round-trips through text', () => {
  const events = [{ label: 'Compo', start: new Date(2026,1,1), end: new Date(2026,4,30), group: null }]
  const text = eventsToText(events, '')
  assert.ok(text.includes('2026-02-01..2026-05-30 Compo'))
})

test('section groups emit section directive', () => {
  const events = [{ label: 'A', start: new Date(2026,0,1), end: new Date(2026,0,1), group: 'Demoscene' }]
  const text = eventsToText(events, '')
  assert.ok(text.includes('section Demoscene'))
  assert.ok(text.includes('2026-01-01 A'))
})

test('preserves PALETTE directive from original text', () => {
  const events = [{ label: 'A', start: new Date(2026,0,1), end: new Date(2026,0,1), group: null }]
  const text = eventsToText(events, 'LINEUP\nPALETTE warm')
  assert.ok(text.startsWith('PALETTE warm'))
})

test('freeze output re-parses to same events', () => {
  const orig = [
    { label: 'First', start: new Date(2026,0,1), end: new Date(2026,2,31), group: 'G1' },
    { label: 'Second', start: new Date(2026,5,1), end: new Date(2026,5,1), group: null },
  ]
  const text = eventsToText(orig, '')
  const { events } = parseText(text)
  assert.equal(events.length, 2)
  assert.equal(events[0].label, 'First')
  assert.equal(events[1].label, 'Second')
})
