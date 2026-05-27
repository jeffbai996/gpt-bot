import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../src/tools/registry.ts'

// Gap coverage for ToolRegistry: the dispatch try/catch error branch, has(),
// and toOpenAITools registration-order preservation.

function makeTool(name: string, exec?: () => Promise<string>) {
  return {
    name,
    description: `desc for ${name}`,
    parameters: { type: 'object' as const, properties: {} },
    execute: exec ?? (async () => `ran ${name}`)
  }
}

test('ToolRegistry: dispatch wraps thrown errors with tool name', async () => {
  const r = new ToolRegistry()
  r.register(makeTool('boom', async () => { throw new Error('kaboom') }))
  const out = await r.dispatch('boom', {}, {})
  assert.match(out, /Error in boom/)
  assert.match(out, /kaboom/)
})

test('ToolRegistry: dispatch handles non-Error throws', async () => {
  const r = new ToolRegistry()
  r.register(makeTool('weird', async () => { throw 'string failure' }))
  const out = await r.dispatch('weird', {}, {})
  assert.match(out, /Error in weird/)
  assert.match(out, /string failure/)
})

test('ToolRegistry: has() reflects registration', () => {
  const r = new ToolRegistry()
  assert.equal(r.has('x'), false)
  r.register(makeTool('x'))
  assert.equal(r.has('x'), true)
  assert.equal(r.has('y'), false)
})

test('ToolRegistry: toOpenAITools preserves registration order', () => {
  const r = new ToolRegistry()
  r.register(makeTool('first'))
  r.register(makeTool('second'))
  r.register(makeTool('third'))
  const names = r.toOpenAITools().map(t => t.function.name)
  assert.deepEqual(names, ['first', 'second', 'third'])
})

test('ToolRegistry: toOpenAITools passes through parameters and description', () => {
  const r = new ToolRegistry()
  r.register({
    name: 'p',
    description: 'pdesc',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    async execute() { return '' }
  })
  const wrapped = r.toOpenAITools()[0]
  assert.equal(wrapped.function.description, 'pdesc')
  assert.deepEqual(wrapped.function.parameters, {
    type: 'object', properties: { q: { type: 'string' } }, required: ['q']
  })
})

test('ToolRegistry: empty registry yields empty tools array and size 0', () => {
  const r = new ToolRegistry()
  assert.equal(r.size(), 0)
  assert.deepEqual(r.toOpenAITools(), [])
})
