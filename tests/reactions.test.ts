import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { actionFor, isValidOutboundReactEmoji } from '../src/reactions/vocabulary.ts'
import { PendingEditsStore } from '../src/reactions/pending-edits.ts'
import { PinnedFactsStore } from '../src/pinned-facts.ts'

test('actionFor: known emojis map to actions', () => {
  assert.equal(actionFor('🔁'), 'regenerate')
  assert.equal(actionFor('🔍'), 'expand')
  assert.equal(actionFor('📌'), 'pin')
  assert.equal(actionFor('❌'), 'delete')
  assert.equal(actionFor('🔇'), 'mute')
  assert.equal(actionFor('🔊'), 'unmute')
  assert.equal(actionFor('✏️'), 'markForEdit')
})

test('actionFor: unknown emoji returns null', () => {
  assert.equal(actionFor('🐢'), null)
  assert.equal(actionFor('a'), null)
  assert.equal(actionFor(''), null)
})

test('isValidOutboundReactEmoji: accepts plain emoji', () => {
  assert.equal(isValidOutboundReactEmoji('👍'), true)
  assert.equal(isValidOutboundReactEmoji('🔥'), true)
  assert.equal(isValidOutboundReactEmoji('😊'), true)
})

test('isValidOutboundReactEmoji: accepts ZWJ sequences', () => {
  assert.equal(isValidOutboundReactEmoji('👨‍👩‍👧‍👦'), true)
  assert.equal(isValidOutboundReactEmoji('🏳️‍🌈'), true)
})

test('isValidOutboundReactEmoji: rejects custom Discord names + plain text', () => {
  assert.equal(isValidOutboundReactEmoji(':custom_name:'), false)
  assert.equal(isValidOutboundReactEmoji('hello'), false)
  assert.equal(isValidOutboundReactEmoji(''), false)
  assert.equal(isValidOutboundReactEmoji(null), false)
  assert.equal(isValidOutboundReactEmoji(undefined), false)
})

test('PendingEditsStore: set / get / clear', () => {
  const store = new PendingEditsStore()
  assert.equal(store.get('c1'), null)

  store.set('c1', 'msg-123')
  assert.equal(store.get('c1'), 'msg-123')

  store.clear('c1')
  assert.equal(store.get('c1'), null)
})

test('PendingEditsStore: TTL expiry', () => {
  const store = new PendingEditsStore()
  store.set('c1', 'msg-123', 1)  // 1ms TTL
  // Spin a tiny busy-loop to advance wall clock past the TTL.
  const start = Date.now()
  while (Date.now() - start < 5) { /* spin */ }
  assert.equal(store.get('c1'), null)
})

let tmpDir: string
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pinned-'))
})

test('PinnedFactsStore: append + read round-trip', async () => {
  const file = path.join(tmpDir, 'pinned.md')
  const store = new PinnedFactsStore(file)

  await store.append('chan-1', 'general', 'first fact')
  await store.append('chan-1', 'general', 'second fact')
  await store.append('chan-2', 'random', 'other channel')

  const c1 = await store.readForChannel('chan-1')
  assert.equal(c1.length, 2)
  assert.equal(c1[0].content, 'first fact')
  assert.equal(c1[1].content, 'second fact')

  const c2 = await store.readForChannel('chan-2')
  assert.equal(c2.length, 1)
  assert.equal(c2[0].content, 'other channel')
})

test('PinnedFactsStore: readForChannel returns empty for unknown channel', async () => {
  const store = new PinnedFactsStore(path.join(tmpDir, 'pinned.md'))
  const out = await store.readForChannel('nonexistent')
  assert.deepEqual(out, [])
})

test('PinnedFactsStore: truncates long content', async () => {
  const store = new PinnedFactsStore(path.join(tmpDir, 'pinned.md'))
  const huge = 'x'.repeat(3000)
  await store.append('c', 'general', huge)
  const facts = await store.readForChannel('c')
  assert.equal(facts.length, 1)
  assert.ok(facts[0].content.length < 1700)
  assert.ok(facts[0].content.endsWith('...'))
})

test('PinnedFactsStore: readForChannelSync mirrors readForChannel', async () => {
  const file = path.join(tmpDir, 'pinned.md')
  const store = new PinnedFactsStore(file)
  await store.append('c', 'general', 'sync-test')

  const sync = store.readForChannelSync('c')
  assert.match(sync, /sync-test/)

  const empty = store.readForChannelSync('nope')
  assert.equal(empty, '')
})
