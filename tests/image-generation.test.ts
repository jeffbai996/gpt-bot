import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatImageFooter, generateImage, imageCost, quotePrompt } from '../src/image-generation.ts'
import { executeGptCommand, gptCommand } from '../src/commands.ts'
import { parseStructuredReply } from '../src/openai.ts'
import { parseImageRequest } from '../src/image-conversation.ts'

test('conversation parser preserves image actions through API envelopes', () => {
  const action = JSON.stringify({ image_request: { prompt: 'A blue cube', use_reference: true } })
  assert.equal(parseImageRequest(parseStructuredReply(action).reply)?.useReference, true)
  assert.equal(parseImageRequest(parseStructuredReply(JSON.stringify({ reply: action })).reply)?.prompt, 'A blue cube')
})

test('reference image uses edits multipart and preserves cancellation', async () => {
  const controller = new AbortController()
  await generateImage('key', { prompt: 'Give the cat a crown', images: [{ data: Buffer.from('source'), mimeType: 'image/png' }], signal: controller.signal }, async (url, init) => {
    assert.match(String(url), /\/images\/edits$/)
    assert.ok(init?.body instanceof FormData)
    assert.equal(init.body.get('model'), 'gpt-image-2.5-sunburst')
    assert.equal(init.body.get('prompt'), 'Give the cat a crown')
    assert.equal(await (init.body.get('image[]') as Blob).text(), 'source')
    controller.abort()
    assert.equal(init.signal?.aborted, true)
    return Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] })
  })
})

test('image slash schema is valid and the handler defers then attaches', async () => {
  assert.ok(gptCommand.toJSON().options?.some(x => x.name === 'image'))
  const original = globalThis.fetch
  const key = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'example-key'
  const events: string[] = []
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).model, 'gpt-image-2.5-sunburst')
    return Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] })
  }
  const interaction = {
    user: { id: 'example-admin' },
    options: { getSubcommand: () => 'image', getString: (name: string) => name === 'prompt' ? 'A cube' : null },
    deferReply: async () => { events.push('defer') },
    editReply: async (reply: any) => { events.push('attach'); assert.ok(Buffer.isBuffer(reply.files[0].attachment)) },
  }
  try {
    await executeGptCommand(interaction as any, {} as any, 'example-admin')
    assert.deepEqual(events, ['defer', 'attach'])
  } finally {
    globalThis.fetch = original
    if (key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = key
  }
})

test('unauthorized image request stops before reading options or calling API', async () => {
  let denied = false
  await executeGptCommand({ user: { id: 'example-user' }, reply: async () => { denied = true } } as any, {} as any, 'example-admin')
  assert.equal(denied, true)
})

test('maps image options and decodes the attachment', async () => {
  const result = await generateImage('example-key', { prompt: 'A blue cube', size: '1536x1024', quality: 'low' }, async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'gpt-image-2.5-sunburst', prompt: 'A blue cube', size: '1536x1024', quality: 'low', n: 1, output_format: 'png' })
    return Response.json({ data: [{ b64_json: Buffer.from('image').toString('base64') }] })
  })
  assert.equal(result.attachment.toString(), 'image')
  assert.equal(result.name, 'gpt-image.png')
})

test('rejects missing credentials without a request', async () => {
  await assert.rejects(generateImage('', { prompt: 'cube' }, async () => { throw new Error('called') }), /OPENAI_API_KEY/)
})

test('does not expose provider error bodies or retry billable requests', async () => {
  let calls = 0
  await assert.rejects(generateImage('key', { prompt: 'cube' }, async () => {
    calls++
    return Response.json({ error: { message: 'private diagnostic' } }, { status: 403 })
  }), /HTTP 403/)
  assert.equal(calls, 1)
})

test('rejects empty image responses', async () => {
  await assert.rejects(generateImage('key', { prompt: 'cube' }, async () => Response.json({ data: [] })), /no image/)
})

test('prices a generation from the provider token split', () => {
  // gpt-image-2: $5/M text in, $8/M image in, $30/M out.
  const cost = imageCost('gpt-image-2', {
    inputTokens: 1_100, textInputTokens: 100, imageInputTokens: 1_000, outputTokens: 1_584,
  })
  assert.ok(cost !== undefined)
  assert.equal(Number(cost!.toFixed(6)), Number((100 * 5e-6 + 1000 * 8e-6 + 1584 * 30e-6).toFixed(6)))
})

test('an unpriced model or a missing usage block costs undefined, never zero', () => {
  assert.equal(imageCost('dall-e-9', { inputTokens: 1, textInputTokens: 1, imageInputTokens: 0, outputTokens: 1 }), undefined)
  assert.equal(imageCost('gpt-image-2', undefined), undefined)
})

test('carries usage, cost and elapsed off the API response', async () => {
  const result = await generateImage('example-key', { prompt: 'A blue cube' }, async () =>
    Response.json({
      data: [{ b64_json: Buffer.from('image').toString('base64') }],
      usage: { input_tokens: 30, output_tokens: 1_056, input_tokens_details: { text_tokens: 30, image_tokens: 0 } },
    }))
  assert.equal(result.model, 'gpt-image-2.5-sunburst')
  assert.equal(result.usage?.outputTokens, 1_056)
  assert.equal(result.costUsd, (30 * 5 + 1_056 * 30) / 1_000_000)
  assert.ok(result.elapsedMs >= 0)
})

test('the footer stacks the ordinary turn counter over model and cost', () => {
  const footer = formatImageFooter({
    model: 'gpt-image-2', size: '1024x1024', quality: 'medium',
    usage: { inputTokens: 30, textInputTokens: 30, imageInputTokens: 0, outputTokens: 1_056 },
    costUsd: 0.03183, elapsedMs: 12_400,
  })
  const rows = footer.split('\n')
  assert.equal(rows.length, 2)
  assert.match(rows[0], /input ↑ {1,}30/)
  assert.match(rows[0], /output ↓ {1,}1,056/)
  assert.match(rows[0], /◷ {0,}12\.4s/)
  assert.match(rows[1], /gpt-image-2 · 1024x1024 medium · ~\$0\.032/)
  // Two pills of different widths render as two ragged boxes on Discord.
  assert.equal(rows[0].length, rows[1].length)
})

test('a provider that returned no usage still names the model and the clock', () => {
  const footer = formatImageFooter({
    model: 'gpt-image-1-mini', size: 'auto', quality: 'low', elapsedMs: 3_000,
  })
  assert.equal(footer.split('\n').length, 1)
  assert.match(footer, /gpt-image-1-mini · auto low · ◷ 3\.0s/)
  assert.doesNotMatch(footer, /\$/)
})

test('a quoted prompt stays inside Discord message limits', () => {
  // /gpt image takes 4000 characters; a Discord message holds 2000. An
  // over-long quote means the reply never sends and a billed image is lost.
  const quoted = quotePrompt('x'.repeat(4_000))
  assert.ok(quoted.length < 1_600, String(quoted.length))
  assert.ok(quoted.endsWith('…'))
  assert.equal(quotePrompt('one\ntwo'), '**Prompt**\n> one\n> two')
})

test('conversational images attach the same token and cost footer as slash images', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  assert.match(source, /generatedImageFooter = formatImageFooter\(image\)/)
  // `sent` is result.files.slice(0, 10), bound one line up so the delivery
  // ledger can record exactly what Discord accepted.
  assert.match(source, /const sent = result\.files\.slice\(0, 10\)/)
  assert.match(source, /content: generatedImageFooter \|\| undefined,\s+files: sent,/)
})
