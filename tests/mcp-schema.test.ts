import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpSchemaToOpenAI } from '../src/tools/mcp-schema.ts'

test('mcpSchemaToOpenAI: simple object schema', () => {
  const out = mcpSchemaToOpenAI({
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'ticker' },
      qty: { type: 'integer' }
    },
    required: ['symbol']
  })
  assert.equal(out?.type, 'object')
  assert.deepEqual(out?.required, ['symbol'])
  assert.equal((out!.properties as any).symbol.type, 'string')
  assert.equal((out!.properties as any).qty.type, 'integer')
})

test('mcpSchemaToOpenAI: collapses nullable types', () => {
  const out = mcpSchemaToOpenAI({
    type: 'object',
    properties: {
      maybe: { type: ['string', 'null'] }
    }
  })
  assert.equal((out!.properties as any).maybe.type, 'string')
})

test('mcpSchemaToOpenAI: drops unrepresentable properties (anyOf)', () => {
  const out = mcpSchemaToOpenAI({
    type: 'object',
    properties: {
      good: { type: 'string' },
      bad: { anyOf: [{ type: 'string' }, { type: 'number' }] }
    },
    required: ['good', 'bad']
  })
  assert.deepEqual(Object.keys(out!.properties), ['good'])
  // required filters down to surviving props.
  assert.deepEqual(out?.required, ['good'])
})

test('mcpSchemaToOpenAI: array of strings', () => {
  const out = mcpSchemaToOpenAI({
    type: 'object',
    properties: {
      tags: { type: 'array', items: { type: 'string' } }
    }
  })
  const tags = (out!.properties as any).tags
  assert.equal(tags.type, 'array')
  assert.equal(tags.items.type, 'string')
})

test('mcpSchemaToOpenAI: returns null when root is not object', () => {
  assert.equal(mcpSchemaToOpenAI({ type: 'string' }), null)
  assert.equal(mcpSchemaToOpenAI(null), null)
  assert.equal(mcpSchemaToOpenAI({ anyOf: [{ type: 'object' }] }), null)
})

test('mcpSchemaToOpenAI: preserves description and enum', () => {
  const out = mcpSchemaToOpenAI({
    type: 'object',
    description: 'thing',
    properties: {
      side: { type: 'string', enum: ['buy', 'sell'] }
    }
  })
  assert.equal(out?.description, 'thing')
  assert.deepEqual((out!.properties as any).side.enum, ['buy', 'sell'])
})
