import type { ToolCall } from './openai.ts'

export const CROSSPOST_DONE_SIGNAL = '[[crossposted]]'

export interface CrosspostedDiscordMessage {
  channelId: string
  messageId: string
}

const DISCORD_POST_TOOL = /(?:^|[._-])discord_(?:send|reply)$/

function successfulDiscordPost(call: ToolCall): CrosspostedDiscordMessage | null {
  if (call.failed || !DISCORD_POST_TOOL.test(call.name)) return null
  try {
    const result = JSON.parse(call.resultPreview) as Record<string, unknown>
    const channelId = typeof result.channel_id === 'string' ? result.channel_id : ''
    const messageId = typeof result.message_id === 'string' ? result.message_id : ''
    return result.ok === true && channelId && messageId ? { channelId, messageId } : null
  } catch {
    return null
  }
}

/** Successful Discord posts whose destination differs from this turn's source channel. */
export function crosspostedDiscordMessages(
  toolCalls: readonly ToolCall[],
  sourceChannelId: string,
): CrosspostedDiscordMessage[] {
  const seen = new Set<string>()
  return toolCalls.flatMap(call => {
    const post = successfulDiscordPost(call)
    if (!post || post.channelId === sourceChannelId) return []
    const key = `${post.channelId}:${post.messageId}`
    if (seen.has(key)) return []
    seen.add(key)
    return [post]
  })
}

/**
 * A successful crosspost is the durable answer.  Never leave a second receipt
 * (or a model-written acknowledgement) in the origin: the 🔀 reaction is its
 * only UI there.  The explicit signal remains a defensive no-op if a model
 * emits it after a failed send.
 */
export function shouldQuietCrosspostReceipt(
  reply: string,
  crossposts: readonly CrosspostedDiscordMessage[],
): boolean {
  const body = reply.trim()
  return body === CROSSPOST_DONE_SIGNAL || crossposts.length > 0
}
