import { strict as assert } from 'assert'
import { parseText, renderSVG } from '../src/client/timeline.js'

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
