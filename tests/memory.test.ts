import { test } from 'node:test'
import assert from 'node:assert/strict'
import { embed } from '../src/memory.ts'

test('embed: returns null for empty input', async () => {
  const stub = { embeddings: { create: async () => ({ data: [{ embedding: [1, 2, 3] }] }) } } as any
  assert.equal(await embed(stub, ''), null)
  assert.equal(await embed(stub, '   '), null)
})

test('embed: returns vector on success', async () => {
  const stub = { embeddings: { create: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) } } as any
  const out = await embed(stub, 'hello')
  assert.deepEqual(out, [0.1, 0.2, 0.3])
})

test('embed: returns null if API call throws', async () => {
  const stub = {
    embeddings: { create: async () => { throw new Error('boom') } }
  } as any
  assert.equal(await embed(stub, 'hello'), null)
})

test('embed: returns null if API returns no data', async () => {
  const stub = { embeddings: { create: async () => ({ data: [] }) } } as any
  assert.equal(await embed(stub, 'hello'), null)
})

// MemoryStore.open() is intentionally not unit-tested here — it's a thin
// wrapper around better-sqlite3 + sqlite-vss that requires a real native
// runtime. Native-module behavior is verified live in the integration probe.
