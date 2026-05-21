import type { TextChannel, DMChannel, ThreadChannel } from 'discord.js'
import type OpenAI from 'openai'

export interface HistoryAttachment {
  name: string
  url: string
  mimeType: string | null
}

export interface HistoryMessage {
  id: string
  authorId: string
  authorName: string
  content: string
  attachments: HistoryAttachment[]
}

// Upper bound for the raw Discord fetch. Discord caps fetch at 100 per call.
// We fetch this many, then trimToTokenBudget() drops the oldest until the
// remaining content fits within GPT_HISTORY_TOKEN_BUDGET.
const HISTORY_RAW_LIMIT = 30

// Approximate token-budget cap on conversation history sent per turn. The
// previous behavior was "fetch last 30, send them all" — a chatty channel
// with 30 multi-paragraph messages would silently send 10k+ tokens of
// history on every reply. With GPT-5.5 at $5/$30 per 1M tokens that's
// nontrivial cost per turn before the model has even started reasoning.
//
// 8k tokens covers ~12-20 typical Discord turns of context, which is plenty
// for chat. Override via GPT_HISTORY_TOKEN_BUDGET=<n>.
//
// We approximate token count as chars/4 — accurate enough for budgeting
// purposes without pulling in tiktoken. The budget is intentionally generous
// (the trim is a fail-safe, not a tight squeeze).
const HISTORY_TOKEN_BUDGET = parseInt(
  process.env.GPT_HISTORY_TOKEN_BUDGET ?? '8000',
  10,
)
const CHARS_PER_TOKEN_APPROX = 4

// Always retain at least this many recent messages even if they exceed
// the budget, so we never drop conversation completely.
const MIN_RETAIN = 3

export async function fetchHistory(
  channel: TextChannel | DMChannel | ThreadChannel,
  beforeMessageId: string,
  limit: number = HISTORY_RAW_LIMIT
): Promise<HistoryMessage[]> {
  const fetched = await channel.messages.fetch({ limit, before: beforeMessageId })
  const arr: HistoryMessage[] = []
  for (const m of fetched.values()) {
    arr.push({
      id: m.id,
      authorId: m.author.id,
      authorName: m.author.username,
      content: m.content,
      attachments: [...m.attachments.values()].map(a => ({
        name: a.name,
        url: a.url,
        mimeType: a.contentType
      }))
    })
  }
  // Discord returns newest-first; reverse to chronological order.
  return arr.reverse()
}

function describeAttachment(att: HistoryAttachment): string {
  const mime = att.mimeType ?? ''
  const kind = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio'
    : 'file'
  return `[previous ${kind}: ${att.name}]`
}

// Strip metadata lines the bot adds to its own replies (verbose footer, etc.)
// before feeding past replies back into context. Without this, the model
// pattern-matches its own footer format and starts hallucinating
// `↑ X · ↓ Y · » Zs` lines inside its reply text. Discord's `-# ` directive
// is reserved for metadata in this bot, so any line starting with `-# ` drops.
export function stripBotMetadata(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('-# ')) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

// Convert Discord history into OpenAI Chat Completions message format. Bot's
// own messages become `assistant`; everyone else becomes `user`. Author name
// is prefixed inside `user` content because OpenAI's `name` field strips
// non-ASCII and is finicky with Discord usernames.
export function formatHistoryForOpenAI(
  messages: HistoryMessage[],
  selfId: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
  for (const m of messages) {
    const isBot = m.authorId === selfId
    const attachmentNote = m.attachments.length
      ? '\n' + m.attachments.map(describeAttachment).join('\n')
      : ''
    const content = isBot
      ? stripBotMetadata(m.content) + attachmentNote
      : `${m.authorName}: ${m.content}${attachmentNote}`

    if (!content.trim()) continue

    out.push({
      role: isBot ? 'assistant' : 'user',
      content
    })
  }
  return trimToTokenBudget(out)
}

/**
 * Drop oldest messages until the total approximate token count fits within
 * HISTORY_TOKEN_BUDGET. Always keeps at least MIN_RETAIN trailing messages
 * so a single huge user message can't blank the whole context.
 */
function trimToTokenBudget(
  msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  if (msgs.length <= MIN_RETAIN) return msgs

  const tokenOf = (m: OpenAI.Chat.Completions.ChatCompletionMessageParam): number => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    return Math.ceil(c.length / CHARS_PER_TOKEN_APPROX)
  }

  let total = msgs.reduce((s, m) => s + tokenOf(m), 0)
  if (total <= HISTORY_TOKEN_BUDGET) return msgs

  let trimmed = msgs.slice()
  while (trimmed.length > MIN_RETAIN && total > HISTORY_TOKEN_BUDGET) {
    const dropped = trimmed.shift()!
    total -= tokenOf(dropped)
  }
  return trimmed
}
