import OpenAI from 'openai'

export interface ParsedResponse {
  react: string | null   // optional emoji to add to the user's message
  reply: string          // text to post (may be empty if react-only)
}

export interface RespondInput {
  systemPrompt: string
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  userMessage: string
  userName: string
  model: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
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

// o-series models use a different parameter shape (no `temperature`,
// `reasoning_effort` is meaningful). gpt-5.x accepts standard params.
function isReasoningModel(model: string): boolean {
  return model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')
}

export class OpenAIClient {
  private client: OpenAI
  public readonly defaultModel: string

  constructor(apiKey: string, defaultModel: string) {
    this.client = new OpenAI({ apiKey })
    this.defaultModel = defaultModel
  }

  async respond(input: RespondInput): Promise<RespondResult> {
    const { systemPrompt, history, userMessage, userName, model, reasoningEffort } = input
    const start = Date.now()

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${systemPrompt}\n\n---\n\n${STRUCTURED_OUTPUT_INSTRUCTION}` },
      ...history,
      { role: 'user', content: `${userName}: ${userMessage}` }
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

    try {
      const resp = await this.client.chat.completions.create({
        model,
        messages,
        response_format: { type: 'json_object' },
        ...(reasoning
          ? { reasoning_effort: sdkEffort }
          : { temperature: 0.7, max_tokens: 4096 })
      })

      const choice = resp.choices?.[0]
      const raw = choice?.message?.content ?? ''
      const parsed = parseStructuredReply(raw)

      return {
        react: parsed.react,
        reply: parsed.reply,
        usage: resp.usage
          ? {
              inputTokens: resp.usage.prompt_tokens ?? 0,
              outputTokens: resp.usage.completion_tokens ?? 0,
              totalTokens: resp.usage.total_tokens ?? 0
            }
          : null,
        finishReason: choice?.finish_reason ?? null,
        durationMs: Date.now() - start,
        modelUsed: resp.model ?? model
      }
    } catch (e: any) {
      // Convert known refusal/quota patterns into a typed rejection so the
      // caller can react ⚠️ vs ❌ appropriately. Everything else bubbles.
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
