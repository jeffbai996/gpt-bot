import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendNarrationTrace,
  formatHeartbeatFooter,
  formatLiveWorkMessage,
  formatReasoningSnapshot,
  formatReasoningTraceSnapshot,
  heartbeatVisual,
  latestReasoningHeadline,
  nextHeartbeatVerb,
  pickHeartbeatGlyph,
  pickHeartbeatVerb,
  resolveHeartbeatDelay,
  shouldRenderHeartbeat,
} from '../src/live-ui.ts'

test('picks one heartbeat verb from the compact status pool', () => {
  assert.equal(pickHeartbeatVerb(() => 0), 'cogitating')
  assert.equal(pickHeartbeatVerb(() => 0.999), 'scheming')
})

test('advances heartbeat verbs without repeating and wraps the pool', () => {
  assert.equal(nextHeartbeatVerb('cogitating'), 'pondering')
  assert.equal(nextHeartbeatVerb('scheming'), 'cogitating')
})

test('cycles the heartbeat glyph animation by frame', () => {
  assert.equal(pickHeartbeatGlyph(0), '✻')
  assert.equal(pickHeartbeatGlyph(1), '✢')
  assert.equal(pickHeartbeatGlyph(6), '✻')
})

test('keeps the verb stable for four frames before advancing it', () => {
  assert.deepEqual(heartbeatVisual(3, 'cogitating'), { glyph: '✶', verb: 'cogitating' })
  assert.deepEqual(heartbeatVisual(4, 'cogitating'), { glyph: '✷', verb: 'pondering' })
})

test('delays the heartbeat row until the turn has run for three minutes', () => {
  const delay = resolveHeartbeatDelay(undefined)
  assert.equal(delay, 180_000)
  assert.equal(shouldRenderHeartbeat(179_999, 0, delay), false)
  assert.equal(shouldRenderHeartbeat(180_000, 60_000, delay), true)
  assert.equal(resolveHeartbeatDelay('240000'), 240_000)
})

test('long active turns retain a heartbeat', () => {
  assert.equal(shouldRenderHeartbeat(600_000, 5_000, 60_000), true)
})

test('renders heartbeat status in the same small gray style as token counters', () => {
  assert.equal(
    formatHeartbeatFooter(33_000, 4_000, 'cogitating', '✶'),
    '-# ` ✶ still cogitating · 33s `',
  )
})

test('keeps the thinking header above quoted live progress', () => {
  assert.equal(
    formatLiveWorkMessage({ effortLabel: 'thinking with max effort', detail: 'Checking the renderer.' }),
    '💭 ✻ **thinking with max effort…**\n> Checking the renderer.',
  )
})

test('compaction replaces the thinking card with the paper indicator', () => {
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking with high effort',
      activity: 'compacting',
      headline: 'stale reasoning should not leak through',
      detail: 'stale progress should not leak through',
      spinnerGlyph: '✶',
      spinnerDots: '..',
    }),
    '📝 ✶ **Compacting context..**',
  )
})

test('keeps the effort header and renders the latest reasoning one-liner beneath it', () => {
  assert.equal(
    latestReasoningHeadline([
      'Analyzing launchpad UI visibility states',
      'Clarifying homepage mode UI restrictions',
      'Investigating hidden transition class toggling',
    ].join('\n')),
    'Investigating hidden transition class toggling',
  )
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking with high effort',
      headline: 'Investigating hidden transition class toggling',
    }),
    '💭 ✻ **thinking with high effort…**\n> 🧠 *investigating hidden transition class toggling*',
  )
})

test('renders the spinner frame and reasoning description in the same message tick', () => {
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking with high effort',
      headline: 'Checking Discord Edit Ownership',
      detail: 'Inspecting the live renderer.',
      spinnerGlyph: '✶',
      spinnerDots: '..',
    }),
    '💭 ✶ **thinking with high effort..**\n> 🧠 *checking discord edit ownership*\n> Inspecting the live renderer.',
  )
})

test('narration renders beneath thinking as a quote block', () => {
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking with high effort',
      detail: 'Inspecting the live renderer.',
    }),
    '💭 ✻ **thinking with high effort…**\n> Inspecting the live renderer.',
  )
})

test('collapse narration keeps distinct entries in arrival order', () => {
  let trace: string[] = []
  trace = appendNarrationTrace(trace, 'Checking the first path.')
  trace = appendNarrationTrace(trace, 'Checking the first path.')
  trace = appendNarrationTrace(trace, 'Checking the second path.')
  assert.deepEqual(trace, ['Checking the first path.', 'Checking the second path.'])
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking with high effort',
      narrationTrace: trace,
    }),
    [
      '💭 ✻ **thinking with high effort…**',
      '> Checking the first path.',
      '>',
      '> Checking the second path.',
    ].join('\n'),
  )
})

test('collapses completed reasoning into one latest in-place brain line', () => {
  assert.equal(
    formatReasoningSnapshot([
      'Checking the first failure mode',
      'Comparing the second failure mode',
      'Fixing the actual edit owner',
    ].join('\n')),
    '💭 **Thinking:**\n> 🧠 *fixing the actual edit owner*',
  )
})

test('completed live reasoning keeps the brain line under the thought duration', () => {
  assert.equal(
    formatReasoningSnapshot(
      'Fixing the actual edit owner',
      '💭 ✓ **thought for 19s**',
    ),
    '💭 ✓ **thought for 19s**\n> 🧠 *fixing the actual edit owner*',
  )
})

test('collapse mode accumulates the whole reasoning trace line by line', () => {
  assert.equal(
    formatReasoningTraceSnapshot([
      'Checking the first failure mode',
      'Comparing the second failure mode\nFixing the actual edit owner',
    ]),
    [
      '💭 **Thinking:**',
      '> 🧠 *checking the first failure mode*',
      '> 🧠 *comparing the second failure mode*',
      '> 🧠 *fixing the actual edit owner*',
    ].join('\n'),
  )
})

test('completed collapse reasoning keeps every brain line under the thought duration', () => {
  assert.equal(
    formatReasoningTraceSnapshot(
      ['First pass', 'Second pass'],
      '💭 ✓ **thought for 19s**',
    ),
    [
      '💭 ✓ **thought for 19s**',
      '> 🧠 *first pass*',
      '> 🧠 *second pass*',
    ].join('\n'),
  )
})

test('live work message renders accumulated reasoning without replacing old lines', () => {
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking with high effort',
      reasoningTrace: ['First pass', 'Second pass'],
    }),
    [
      '💭 ✻ **thinking with high effort…**',
      '> 🧠 *first pass*',
      '> 🧠 *second pass*',
    ].join('\n'),
  )
})

test('keeps the inactivity bar alongside the self-updating brain slot', () => {
  const rendered = formatLiveWorkMessage({
    effortLabel: 'thinking with high effort',
    headline: latestReasoningHeadline('Old line\nNew line'),
    footer: '-# ` ✶ still cogitating · 1m 3s `',
  })

  assert.equal(rendered.match(/🧠/g)?.length, 1)
  assert.match(rendered, /🧠 \*new line\*/)
  assert.match(rendered, /still cogitating/)
  assert.doesNotMatch(rendered, /old line/i)
})

test('cleans reasoning markdown before promoting it to the live header', () => {
  assert.equal(
    latestReasoningHeadline('## **Analyzing the failure mode**'),
    'Analyzing the failure mode',
  )
})

test('keeps the thinking header when only a heartbeat is available', () => {
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking',
      footer: '`✻ cogitating · 30s`',
    }),
    '💭 ✻ **thinking…**\n\n`✻ cogitating · 30s`',
  )
})

test('keeps commentary above the compact heartbeat row', () => {
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking',
      detail: 'Checking the actual repos.',
      footer: '`✻ cogitating · 33s`',
    }),
    '💭 ✻ **thinking…**\n> Checking the actual repos.\n\n`✻ cogitating · 33s`',
  )
})

test('renders multiline commentary entirely inside one quote block', () => {
  const message = formatLiveWorkMessage({
    effortLabel: 'thinking',
    detail: 'A first line\nand a second line',
  })

  assert.match(message, /\n> A first line\n> and a second line/)
  assert.equal(message.match(/^> /gm)?.length, 2)
})

test('clips progress before the footer instead of dropping the heartbeat', () => {
  const message = formatLiveWorkMessage({
    effortLabel: 'thinking',
    detail: 'abcdefghijklmnopqrstuvwxyz',
    footer: '```\nstill working\n```',
    maxLength: 60,
  })

  assert.ok(message.length <= 60)
  assert.match(message, /^💭 ✻ \*\*thinking…\*\*/)
  assert.match(message, /…\n\n```\nstill working\n```$/)
})

 test('activity footer shows tools and elapsed time, and marks silent periods', () => {
  assert.equal(formatHeartbeatFooter(90_000, 500, 'pondering', '✻', 'running Bash'), '-# ` ✻ running Bash · 1m 30s elapsed `')
  assert.match(formatHeartbeatFooter(180_000, 125_000, 'pondering', '✻', 'thinking'), /waiting · no output for 2m 5s/)
})
