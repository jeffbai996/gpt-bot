import type OpenAI from 'openai'

// Dynamic token-aware history windowing.
//
// gem-bot's analog calls Gemini's `countTokens` API to get an exact token
// count per windowing decision. OpenAI has no free, synchronous token-count
// endpoint (you'd pull in tiktoken or pay for a round-trip), so the default
// counter here is a chars/4 approximation — the same estimate gpt-bot used
// inline before this module existed. The counter is pluggable: pass a custom
// `countTokens` (e.g. a tiktoken-backed one) to selectWithinBudget if exact
// counts ever matter more than the dependency cost.
//
// This replaces the previous "fetch last 30, trim inline" logic in history.ts
// with a reusable, independently-testable function.

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

// Default per-message token estimate: chars/4. Accurate enough for budgeting;
// the budget itself is a generous fail-safe, not a tight squeeze.
const CHARS_PER_TOKEN_APPROX = 4

export function approxTokens(msg: ChatMessage): number {
  const c = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
  return Math.ceil(c.length / CHARS_PER_TOKEN_APPROX)
}

// Synchronous counter over a whole message array. The default sums approxTokens
// per message. A counter is "the function that scores the cost of a candidate
// window" — gem's was async (an API call); ours is sync because chars/4 is
// local. selectWithinBudget tolerates either by awaiting the result.
export type CountTokens = (msgs: ChatMessage[]) => number | Promise<number>

export const defaultCountTokens: CountTokens = (msgs) =>
  msgs.reduce((sum, m) => sum + approxTokens(m), 0)

export interface BudgetOptions {
  budget: number
  // Always retain at least this many trailing messages even if they exceed the
  // budget, so a single huge message can't blank the whole context.
  minRetain?: number
}

/**
 * Drop oldest messages until the windowed token count fits within `budget`.
 * Always keeps at least `minRetain` (default 3) trailing messages.
 *
 * Mirrors gem-bot's selectWithinBudget: peel from the front, re-count, stop
 * when under budget or at the floor. On a counter exception, fall back to the
 * last 20 messages (or fewer) rather than throwing — windowing failure must
 * never kill a turn.
 */
export async function selectWithinBudget(
  msgs: ChatMessage[],
  countTokens: CountTokens = defaultCountTokens,
  opts: BudgetOptions
): Promise<ChatMessage[]> {
  const { budget } = opts
  const minRetain = opts.minRetain ?? 3

  if (msgs.length === 0) return msgs
  if (msgs.length <= minRetain) return msgs
  // budget <= 0 means "no token cap"; keep a sane recency window instead of
  // sending unbounded history.
  if (budget <= 0) return msgs.length > 20 ? msgs.slice(-20) : msgs

  try {
    let current = msgs
    let tokens = await countTokens(current)
    if (tokens <= budget) return current

    while (current.length > minRetain) {
      current = current.slice(1)
      tokens = await countTokens(current)
      if (tokens <= budget) return current
    }
    return current
  } catch (e) {
    console.error('[token-budget] countTokens failed, falling back to last 20 messages:', e)
    return msgs.length > 20 ? msgs.slice(-20) : msgs
  }
}
