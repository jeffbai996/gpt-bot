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
// Token-budget trimming is layered in v0.7+; for now we just take the most
// recent 30 by default to bound the prompt size.
const HISTORY_RAW_LIMIT = 30

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
  return out
}
