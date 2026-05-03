import OpenAI from 'openai'

export interface ParsedResponse {
  react: string | null   // optional emoji to add to the user's message
  reply: string          // text to post (may be empty if react-only)
}

export type LifecycleEvent =
  | { type: 'thinking_start' }
  | { type: 'reasoning_start' }   // first reasoning_summary token (o-series)
  | { type: 'first_token' }       // first content token observed
  | { type: 'partial', reply: string }  // incremental reply (best-effort)
  | { type: 'done' }

export interface RespondInput {
  systemPrompt: string
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  userMessage: string
  userName: string
  model: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  // Multimodal content parts. `imageParts` get spliced into the user message
  // alongside the text; `extraText` is appended below userMessage (e.g. audio
  // transcripts, file extracts, "skipped" notices).
  imageParts?: OpenAI.Chat.Completions.ChatCompletionContentPartImage[]
  extraText?: string
  onEvent?: (event: LifecycleEvent) => void
}

export interface RespondResult extends ParsedResponse {
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  } | null
  finishReason: string | null
  durationMs: number
  modelUsed: string
}

export class OpenAIRequestRejected extends Error {
  constructor(public reason: string, public details?: unknown) {
    super(reason)
    this.name = 'OpenAIRequestRejected'
  }
}

const STRUCTURED_OUTPUT_INSTRUCTION = `
Respond in JSON only, with this exact shape:
{
  "react": "<single Unicode emoji or null>",
  "reply": "<your reply text — may be empty string if react-only>"
}

The "react" field is optional — set to null if no reaction is appropriate.
Use only standard Unicode emojis, never custom Discord emoji codes like :name:.
The "reply" field is the message body posted to the channel; it may use Markdown.
If you have nothing to say (no reply and no react), return {"react": null, "reply": ""}.
`.trim()

// o-series models accept `reasoning_effort` and reject `temperature`.
function isReasoningModel(model: string): boolean {
  return model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')
}

// gpt-5.x rejects custom `temperature` (only default 1.0 is supported) and
// rejects `max_tokens` in favor of `max_completion_tokens`. The o-series has
// the same `max_completion_tokens` requirement. Only legacy gpt-4.x models
// still accept the old `max_tokens` + custom temperature shape — and we don't
// expose those in the channel flag, so just key off model prefix.
function isGpt5Family(model: string): boolean {
  return model.startsWith('gpt-5')
}

export class OpenAIClient {
  private client: OpenAI
  public readonly defaultModel: string

  constructor(apiKey: string, defaultModel: string) {
    this.client = new OpenAI({ apiKey })
    this.defaultModel = defaultModel
  }

  async respond(input: RespondInput): Promise<RespondResult> {
    const { systemPrompt, history, userMessage, userName, model, reasoningEffort, imageParts, extraText, onEvent } = input
    const start = Date.now()

    // Build the user message. Text-only path stays a plain string for legacy
    // shape compatibility. Multimodal path uses the content-parts array.
    const userText = extraText
      ? `${userName}: ${userMessage}\n\n${extraText}`
      : `${userName}: ${userMessage}`

    const userContent: OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] =
      (imageParts && imageParts.length > 0)
        ? [{ type: 'text', text: userText }, ...imageParts]
        : userText

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${systemPrompt}\n\n---\n\n${STRUCTURED_OUTPUT_INSTRUCTION}` },
      ...history,
      { role: 'user', content: userContent }
    ]

    const reasoning = isReasoningModel(model)

    // SDK 4.104 ReasoningEffort union is 'low' | 'medium' | 'high'. We accept
    // 'minimal' from the channel-flag layer as a forward-compat sentinel and
    // collapse it to 'low' here until the SDK catches up.
    const sdkEffort: 'low' | 'medium' | 'high' =
      reasoningEffort === 'minimal' ? 'low'
        : reasoningEffort === 'high' ? 'high'
        : reasoningEffort === 'low' ? 'low'
        : 'medium'

    onEvent?.({ type: 'thinking_start' })

    // Param shape per model family:
    //   o-series (o1*/o3*/o4*): reasoning_effort + max_completion_tokens, no temperature
    //   gpt-5.x: max_completion_tokens, no temperature (locked at default 1.0)
    //   anything else (legacy gpt-4.x etc.): max_tokens + temperature OK
    const gpt5 = isGpt5Family(model)
    const familyParams = reasoning
      ? { reasoning_effort: sdkEffort, max_completion_tokens: 4096 }
      : gpt5
        ? { max_completion_tokens: 4096 }
        : { temperature: 0.7, max_tokens: 4096 }

    try {
      const stream = await this.client.chat.completions.create({
        model,
        messages,
        response_format: { type: 'json_object' },
        stream: true,
        stream_options: { include_usage: true },
        ...familyParams
      })

      let accumulated = ''
      let finishReason: string | null = null
      let usage: RespondResult['usage'] = null
      let modelUsed = model
      let firstTokenSeen = false
      let lastPartialEmit = ''

      for await (const chunk of stream) {
        if (chunk.model) modelUsed = chunk.model
        const choice = chunk.choices?.[0]
        if (choice) {
          const delta = (choice.delta as { content?: string | null })?.content
          if (delta) {
            accumulated += delta
            if (!firstTokenSeen) {
              firstTokenSeen = true
              onEvent?.({ type: 'first_token' })
            }
            // Best-effort incremental reply extraction. Emit `partial` events
            // when the in-progress `"reply": "..."` substring grows by
            // enough to be worth a Discord edit. The caller throttles edits.
            const partial = extractPartialReply(accumulated)
            if (partial && partial !== lastPartialEmit) {
              lastPartialEmit = partial
              onEvent?.({ type: 'partial', reply: partial })
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0
          }
        }
      }

      onEvent?.({ type: 'done' })

      const parsed = parseStructuredReply(accumulated)

      return {
        react: parsed.react,
        reply: parsed.reply,
        usage,
        finishReason,
        durationMs: Date.now() - start,
        modelUsed
      }
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status
      const code = e?.code ?? e?.error?.code
      if (status === 429 || code === 'rate_limit_exceeded' || code === 'insufficient_quota') {
        throw new OpenAIRequestRejected(`rate_limited (${code ?? status})`, e)
      }
      if (status === 400 && /content.*polic|safety/i.test(e?.message ?? '')) {
        throw new OpenAIRequestRejected('content_policy', e)
      }
      throw e
    }
  }
}

// During streaming, find the value of the `"reply"` key in a partial JSON
// object. Doesn't fully parse JSON (the doc is incomplete mid-stream); just
// scans for `"reply"` and walks forward, unescaping common sequences. Returns
// null if the key hasn't appeared yet, or the in-flight string value.
//
// Limitations: doesn't validate matching braces, doesn't handle every JSON
// escape sequence, doesn't notice if `"reply"` appears as part of another
// string. Good enough for Discord progress-edit display.
export function extractPartialReply(raw: string): string | null {
  const keyIdx = raw.indexOf('"reply"')
  if (keyIdx === -1) return null

  // Skip past `"reply"`, optional whitespace, the colon, more whitespace.
  let i = keyIdx + '"reply"'.length
  while (i < raw.length && /\s/.test(raw[i])) i++
  if (raw[i] !== ':') return null
  i++
  while (i < raw.length && /\s/.test(raw[i])) i++

  // Handle a null or non-string value gracefully.
  if (raw[i] !== '"') return null
  i++

  let out = ''
  while (i < raw.length) {
    const c = raw[i]
    if (c === '\\') {
      const next = raw[i + 1]
      if (next === undefined) break
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === 'r') out += '\r'
      else if (next === '"') out += '"'
      else if (next === '\\') out += '\\'
      else if (next === '/') out += '/'
      else if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6)
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
          continue
        }
        // incomplete \u escape — bail without appending
        break
      } else {
        out += next
      }
      i += 2
      continue
    }
    if (c === '"') break  // string terminated cleanly
    out += c
    i++
  }

  return out
}

// Best-effort parser for the structured `{react, reply}` shape. Handles the
// happy path (well-formed JSON) plus three failure modes:
//   1. Model wraps JSON in a markdown code fence — strip the fence.
//   2. Model emits trailing prose after the closing brace — slice to brace.
//   3. Model ignores the format and emits plain prose — treat all as reply.
export function parseStructuredReply(raw: string): ParsedResponse {
  if (!raw) return { react: null, reply: '' }

  let text = raw.trim()

  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence) text = fence[1].trim()

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1)
    try {
      const obj = JSON.parse(candidate) as Partial<ParsedResponse>
      const react = typeof obj.react === 'string' && obj.react.trim() ? obj.react.trim() : null
      const reply = typeof obj.reply === 'string' ? obj.reply : ''
      return { react, reply }
    } catch {
      // fall through to plain-prose handling
    }
  }

  return { react: null, reply: text }
}
