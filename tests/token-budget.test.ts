import test from 'node:test'
import assert from 'node:assert/strict'
import {
  selectWithinBudget,
  approxTokens,
  defaultCountTokens,
  type ChatMessage,
  type CountTokens,
} from '../src/token-budget.ts'

function msg(content: string): ChatMessage {
  return { role: 'user', content }
}

// A counter where each message costs exactly 100 tokens, regardless of length.
// Makes window-size math trivial to assert without depending on chars/4.
const flatCounter: CountTokens = (msgs) => msgs.length * 100

test('approxTokens: chars/4 rounded up', () => {
  assert.equal(approxTokens(msg('')), 0)
  assert.equal(approxTokens(msg('a')), 1)        // ceil(1/4)
  assert.equal(approxTokens(msg('abcd')), 1)     // ceil(4/4)
  assert.equal(approxTokens(msg('abcde')), 2)    // ceil(5/4)
})

test('approxTokens: stringifies non-string content', () => {
  const m: ChatMessage = {
    role: 'user',
    content: [{ type: 'text', text: 'hello world' }],
  }
  // JSON.stringify of the array — just assert it's a positive, finite count.
  assert.ok(approxTokens(m) > 0)
})

test('defaultCountTokens: sums per-message approx', () => {
  const total = defaultCountTokens([msg('abcd'), msg('abcd')]) // 1 + 1
  assert.equal(total, 2)
})

test('selectWithinBudget: empty array returns empty', async () => {
  const out = await selectWithinBudget([], flatCounter, { budget: 100 })
  assert.deepEqual(out, [])
})

test('selectWithinBudget: under minRetain returns unchanged', async () => {
  const msgs = [msg('a'), msg('b')]
  const out = await selectWithinBudget(msgs, flatCounter, { budget: 0, minRetain: 3 })
  assert.deepEqual(out, msgs)
})

test('selectWithinBudget: under budget returns all messages', async () => {
  const msgs = [msg('a'), msg('b'), msg('c'), msg('d')] // 400 tokens
  const out = await selectWithinBudget(msgs, flatCounter, { budget: 1000 })
  assert.equal(out.length, 4)
})

test('selectWithinBudget: drops oldest until under budget', async () => {
  // 5 msgs * 100 = 500; budget 250 → keep 2 newest (200 <= 250).
  const msgs = [msg('1'), msg('2'), msg('3'), msg('4'), msg('5')]
  const out = await selectWithinBudget(msgs, flatCounter, { budget: 250, minRetain: 1 })
  assert.equal(out.length, 2)
  assert.equal((out[0] as any).content, '4')
  assert.equal((out[1] as any).content, '5')
})

test('selectWithinBudget: never drops below minRetain even if over budget', async () => {
  const msgs = [msg('1'), msg('2'), msg('3'), msg('4'), msg('5')]
  // budget 50 is below a single message's cost; floor at minRetain=3.
  const out = await selectWithinBudget(msgs, flatCounter, { budget: 50, minRetain: 3 })
  assert.equal(out.length, 3)
  assert.equal((out[0] as any).content, '3')
})

test('selectWithinBudget: budget <= 0 keeps a recency window of 20', async () => {
  const msgs = Array.from({ length: 30 }, (_, i) => msg(String(i)))
  const out = await selectWithinBudget(msgs, flatCounter, { budget: 0 })
  assert.equal(out.length, 20)
  assert.equal((out[0] as any).content, '10') // last 20: indices 10..29
})

test('selectWithinBudget: counter exception falls back to last 20', async () => {
  const msgs = Array.from({ length: 30 }, (_, i) => msg(String(i)))
  const throwing: CountTokens = () => { throw new Error('boom') }
  const out = await selectWithinBudget(msgs, throwing, { budget: 100 })
  assert.equal(out.length, 20)
})

test('selectWithinBudget: async counter is awaited', async () => {
  const asyncCounter: CountTokens = async (msgs) => msgs.length * 100
  const msgs = [msg('1'), msg('2'), msg('3'), msg('4'), msg('5')]
  const out = await selectWithinBudget(msgs, asyncCounter, { budget: 250, minRetain: 1 })
  assert.equal(out.length, 2)
})

test('selectWithinBudget: default counter trims by chars/4', async () => {
  // Each message ~400 chars = 100 tokens. 5 of them = 500. budget 250 → keep 2.
  const big = 'x'.repeat(400)
  const msgs = [msg(big), msg(big), msg(big), msg(big), msg(big)]
  const out = await selectWithinBudget(msgs, defaultCountTokens, { budget: 250, minRetain: 1 })
  assert.equal(out.length, 2)
})
