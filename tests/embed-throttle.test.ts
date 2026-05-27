import test from 'node:test'
import assert from 'node:assert/strict'

// COOLDOWN_MS is captured at module-load from GPT_EMBED_COOLDOWN_MS, so set it
// before the dynamic import. 1000ms window keeps the math obvious.
process.env.GPT_EMBED_COOLDOWN_MS = '1000'
const { shouldEmbed, _reset } = await import('../src/embed-throttle.ts')

// Drive time deterministically by stubbing Date.now. realNow restores it.
const realNow = Date.now
function withClock(fn: (setNow: (t: number) => void) => void): void {
  let t = 1_000_000
  Date.now = () => t
  try {
    fn((next) => { t = next })
  } finally {
    Date.now = realNow
  }
}

test('embed-throttle: first call for a pair embeds', () => {
  _reset()
  withClock(() => {
    assert.equal(shouldEmbed('chan', 'user'), true)
  })
})

test('embed-throttle: second call within cooldown is skipped', () => {
  _reset()
  withClock((setNow) => {
    assert.equal(shouldEmbed('chan', 'user'), true)
    setNow(1_000_500) // +500ms, inside 1000ms window
    assert.equal(shouldEmbed('chan', 'user'), false)
  })
})

test('embed-throttle: call after cooldown embeds again', () => {
  _reset()
  withClock((setNow) => {
    assert.equal(shouldEmbed('chan', 'user'), true)
    setNow(1_001_001) // +1001ms, past the window
    assert.equal(shouldEmbed('chan', 'user'), true)
  })
})

test('embed-throttle: throttle is per-user within a channel', () => {
  _reset()
  withClock(() => {
    assert.equal(shouldEmbed('chan', 'alice'), true)
    // Bob is a different author — not throttled by Alice's embed.
    assert.equal(shouldEmbed('chan', 'bob'), true)
    // Alice again within window → skipped.
    assert.equal(shouldEmbed('chan', 'alice'), false)
  })
})

test('embed-throttle: throttle is per-channel for the same user', () => {
  _reset()
  withClock(() => {
    assert.equal(shouldEmbed('chanA', 'user'), true)
    // Same user, different channel → independent window.
    assert.equal(shouldEmbed('chanB', 'user'), true)
    assert.equal(shouldEmbed('chanA', 'user'), false)
  })
})

test('embed-throttle: boundary at exactly cooldown is still throttled', () => {
  _reset()
  withClock((setNow) => {
    assert.equal(shouldEmbed('chan', 'user'), true)
    setNow(1_001_000) // exactly +1000ms; `now - last < COOLDOWN` is false → embeds
    assert.equal(shouldEmbed('chan', 'user'), true)
  })
})
