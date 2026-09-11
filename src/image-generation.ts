import { formatUsageCounter } from './usage-counter.ts'

/** Dollars per million tokens, from OpenAI's published image pricing
 * (developers.openai.com/api/docs/pricing, read 2026-09-10). Text and image
 * input are billed at different rates, which is why the Images API breaks
 * `input_tokens` down in `input_tokens_details` — a reference-image edit is
 * mostly image input, a plain generation is almost entirely text.
 *
 * A rate that moves is a rate that silently lies. Update this table, do not
 * add a fudge factor to the total. */
const IMAGE_RATES: Record<string, { textIn: number, imageIn: number, out: number }> = {
  'gpt-image-2':      { textIn: 5.00, imageIn: 8.00, out: 30.00 },
  'gpt-image-1.5':    { textIn: 5.00, imageIn: 8.00, out: 32.00 },
  'gpt-image-1-mini': { textIn: 2.00, imageIn: 2.50, out: 8.00 },
  'gpt-image-1':      { textIn: 5.00, imageIn: 10.00, out: 40.00 },
}

export interface ImageUsage {
  inputTokens: number
  textInputTokens: number
  imageInputTokens: number
  outputTokens: number
}

/** What the call cost, in dollars, or undefined when the provider returned no
 * usage or the model is not in the rate table. An absent number is honest; a
 * zero would read as free. */
export function imageCost(model: string, usage: ImageUsage | undefined): number | undefined {
  const rate = IMAGE_RATES[model]
  if (!rate || !usage) return undefined
  return (usage.textInputTokens * rate.textIn
    + usage.imageInputTokens * rate.imageIn
    + usage.outputTokens * rate.out) / 1_000_000
}

export interface ImageOptions {
  prompt: string
  model?: string
  size?: string
  quality?: string
  images?: Array<{ data: Uint8Array, mimeType: string }>
  signal?: AbortSignal
}

/** Direct Images API: no automatic retries of potentially billable generation. */
export async function generateImage(apiKey: string, options: ImageOptions, request: typeof fetch = fetch) {
  const startedAt = Date.now()
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.')
  const model = options.model ?? 'gpt-image-2'
  if (!['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'].includes(model)) throw new Error('Unsupported image model.')
  const size = options.size ?? '1024x1024'
  const quality = options.quality ?? 'medium'
  if (!['1024x1024', '1536x1024', '1024x1536', 'auto'].includes(size)) throw new Error('Unsupported image size.')
  if (!['low', 'medium', 'high', 'auto'].includes(quality)) throw new Error('Unsupported image quality.')
  if (!options.prompt.trim() || options.prompt.length > 4000) throw new Error('Prompt must be 1–4000 characters.')
  const fields = { model, prompt: options.prompt, size, quality, n: 1, output_format: 'png' }
  const images = options.images ?? []
  if (images.length > 4 || images.some(image => image.data.length > 10 * 1024 * 1024
    || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType))) throw new Error('Unsupported reference image.')
  const form = new FormData()
  if (images.length) {
    for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
    for (const [i, image] of images.entries()) form.append('image[]', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), `reference-${i}.${image.mimeType.split('/')[1]}`)
  }
  const response = await request(`https://api.openai.com/v1/images/${images.length ? 'edits' : 'generations'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, ...(!images.length ? { 'Content-Type': 'application/json' } : {}) },
    body: images.length ? form : JSON.stringify(fields),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
  })
  if (!response.ok) {
    const hint = response.status === 403 ? 'Check model access and organization verification.'
      : response.status === 429 ? 'Check API quota or try again later.' : 'Check API access and request options.'
    throw new Error(`Image API returned HTTP ${response.status}. ${hint}`)
  }
  const result = await response.json() as {
    data?: Array<{ b64_json?: string }>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { text_tokens?: number, image_tokens?: number }
    }
  }
  const encoded = result.data?.[0]?.b64_json
  if (!encoded) throw new Error('Image API returned no image.')
  const attachment = Buffer.from(encoded, 'base64')
  if (!attachment.length) throw new Error('Image API returned no image.')
  if (attachment.length > 10 * 1024 * 1024) throw new Error('Generated image exceeds the 10 MB attachment limit. Try a smaller size.')
  // Older image models answer without a usage block. Everything downstream
  // treats a missing usage as "unknown", never as zero.
  const raw = result.usage
  const usage: ImageUsage | undefined = raw ? {
    inputTokens: raw.input_tokens ?? 0,
    // When the split is absent, bill the whole input at the text rate: a plain
    // generation carries no image input, and that is the cheaper of the two,
    // so the estimate errs low rather than inventing image tokens.
    textInputTokens: raw.input_tokens_details?.text_tokens ?? raw.input_tokens ?? 0,
    imageInputTokens: raw.input_tokens_details?.image_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
  } : undefined
  return {
    attachment,
    name: 'gpt-image.png',
    model,
    size,
    quality,
    usage,
    costUsd: imageCost(model, usage),
    elapsedMs: Date.now() - startedAt,
  }
}

export interface ImageResult {
  model: string
  size: string
  quality: string
  usage?: ImageUsage
  costUsd?: number
  elapsedMs: number
}

/** The two monospace pills under a generated image.
 *
 * Row one is the ordinary turn counter — the same `formatUsageCounter` every
 * text turn uses, so the image command reads as part of the bot rather than a
 * command with its own dialect. Row two names what produced the picture and
 * what it cost. The rows are padded to a shared width because Discord cannot
 * make a multiline inline-code pill, so two pills of different widths render
 * as two ragged boxes.
 */
export function formatImageFooter(result: ImageResult): string {
  const rows: string[] = []
  if (result.usage) {
    const counter = formatUsageCounter('token', {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      // An image call has neither, and passing a zero keeps the counter to its
      // single-row form instead of adding an empty second line.
      cachedInputTokens: 0,
      reasoningTokens: 0,
    }, result.elapsedMs)
    const inner = counter.match(/`(.*)`/)?.[1]
    if (inner) rows.push(inner.replace(/\s+$/, ''))
  }
  const cost = result.costUsd === undefined ? '' : ` · ~$${result.costUsd.toFixed(3)}`
  const seconds = rows.length ? '' : ` · ◷ ${(result.elapsedMs / 1000).toFixed(1)}s`
  rows.push(` ${result.model} · ${result.size} ${result.quality}${seconds}${cost}`)
  const width = Math.max(...rows.map(row => row.length))
  return rows.map(row => `-# \`${row.padEnd(width)} \``).join('\n')
}

// Discord caps a message at 2000 characters and /gpt image accepts a 4000-char
// prompt, so the quote has to be bounded or the reply fails to send and the
// image is lost after it has already been billed.
const QUOTED_PROMPT_MAX = 1_500

/** The prompt as a Discord blockquote, bounded so the message can be sent. */
export function quotePrompt(prompt: string): string {
  const clean = prompt.trim()
  const shown = clean.length > QUOTED_PROMPT_MAX
    ? clean.slice(0, QUOTED_PROMPT_MAX - 1) + '…'
    : clean
  return shown.split('\n').map(line => `> ${line}`).join('\n')
}
