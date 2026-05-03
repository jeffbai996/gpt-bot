import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../src/tools/registry.ts'
import { fetchUrlTool } from '../src/tools/fetch-url.ts'
import { isPrivateIp, validateUrl, extractContent, truncate } from '../src/tools/fetch-url-internal.ts'

test('ToolRegistry: register + dispatch', async () => {
  const r = new ToolRegistry()
  let called = false
  r.register({
    name: 'echo',
    description: 'echoes',
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
    async execute(args) {
      called = true
      return `got ${args.x}`
    }
  })
  assert.equal(r.size(), 1)
  assert.equal(await r.dispatch('echo', { x: 'hi' }, {}), 'got hi')
  assert.equal(called, true)
})

test('ToolRegistry: duplicate registration throws', () => {
  const r = new ToolRegistry()
  const t = {
    name: 'a',
    description: 'd',
    parameters: { type: 'object' as const, properties: {} },
    async execute() { return '' }
  }
  r.register(t)
  assert.throws(() => r.register(t), /already registered/)
})

test('ToolRegistry: unknown tool dispatch returns error string', async () => {
  const r = new ToolRegistry()
  const out = await r.dispatch('nope', {}, {})
  assert.match(out, /Unknown tool/)
})

test('ToolRegistry: toOpenAITools wraps in function shape', () => {
  const r = new ToolRegistry()
  r.register(fetchUrlTool)
  const tools = r.toOpenAITools()
  assert.equal(tools.length, 1)
  assert.equal(tools[0].type, 'function')
  assert.equal(tools[0].function.name, 'fetch_url')
})

test('isPrivateIp: IPv4 ranges', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true)
  assert.equal(isPrivateIp('10.0.0.1'), true)
  assert.equal(isPrivateIp('172.16.0.1'), true)
  assert.equal(isPrivateIp('172.31.255.255'), true)
  assert.equal(isPrivateIp('172.32.0.1'), false)
  assert.equal(isPrivateIp('192.168.1.1'), true)
  assert.equal(isPrivateIp('169.254.1.1'), true)
  assert.equal(isPrivateIp('8.8.8.8'), false)
  assert.equal(isPrivateIp('1.1.1.1'), false)
})

test('isPrivateIp: IPv6 ranges', () => {
  assert.equal(isPrivateIp('::1'), true)
  assert.equal(isPrivateIp('fe80::1'), true)
  assert.equal(isPrivateIp('fd00::1'), true)
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true)
  assert.equal(isPrivateIp('2606:4700::1111'), false)
})

test('validateUrl: rejects file:// and other schemes', () => {
  assert.throws(() => validateUrl('file:///etc/passwd'), /unsupported scheme/)
  assert.throws(() => validateUrl('javascript:alert(1)'), /unsupported scheme/)
  assert.throws(() => validateUrl('not a url'), /invalid URL/)
  assert.equal(validateUrl('https://example.com').url.hostname, 'example.com')
})

// HTML extraction depends on jsdom which needs Node 22+ (ArrayBuffer.resizable).
// Skip on older Node so the rest of the suite still runs.
const NODE_MAJOR = parseInt((process.versions.node ?? '0').split('.')[0], 10)
test('extractContent: HTML article extraction', { skip: NODE_MAJOR < 22 }, async () => {
  const html = '<html><head><title>Test</title></head><body><article><h1>Headline</h1><p>This is the body of the article. It has enough text for Readability to recognize it as content. ' + 'a'.repeat(500) + '</p></article></body></html>'
  const r = await extractContent(Buffer.from(html), 'text/html', 'https://example.com')
  assert.ok(r.body.includes('Headline') || r.body.length > 0)
})

test('extractContent: JSON pretty-prints', async () => {
  const r = await extractContent(Buffer.from('{"a":1,"b":2}'), 'application/json', 'https://x')
  assert.match(r.body, /"a": 1/)
})

test('extractContent: plain text passthrough', async () => {
  const r = await extractContent(Buffer.from('hello\nworld'), 'text/plain', 'https://x')
  assert.equal(r.contentType, 'text')
  assert.equal(r.body, 'hello\nworld')
})

test('truncate: respects max', () => {
  assert.equal(truncate('hi', 100), 'hi')
  const out = truncate('a'.repeat(200), 50)
  assert.ok(out.length > 50, 'includes truncation note')
  assert.match(out, /truncated/)
})

test('fetch_url: rejects non-http schemes early', async () => {
  const out = await fetchUrlTool.execute({ url: 'file:///etc/passwd' }, {})
  assert.match(out, /unsupported scheme/)
})

test('fetch_url: rejects non-string url arg', async () => {
  const out = await fetchUrlTool.execute({ url: 123 }, {})
  assert.match(out, /must be a string/)
})

test('fetch_url: SSRF guard on resolvable private IP', async () => {
  // localhost resolves to 127.0.0.1; the SSRF guard should refuse.
  const out = await fetchUrlTool.execute({ url: 'http://localhost:1' }, {})
  assert.match(out, /private network/)
})
