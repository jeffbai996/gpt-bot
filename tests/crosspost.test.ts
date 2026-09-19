import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CROSSPOST_DONE_SIGNAL,
  crosspostedDiscordMessages,
  shouldQuietCrosspostReceipt,
} from '../src/crosspost.ts'
import type { ToolCall } from '../src/openai.ts'

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    name: 'squad-discord.discord_send',
    args: { channel: 'destination' },
    durationMs: 0,
    resultPreview: JSON.stringify({
      channel_id: 'destination',
      message_id: 'message-1',
      ok: true,
    }),
    failed: false,
    ...overrides,
  }
}

test('crosspostedDiscordMessages keeps successful off-channel Discord posts', () => {
  const posts = crosspostedDiscordMessages([
    call(),
    call({ name: 'squad-discord.discord_reply', resultPreview: JSON.stringify({
      channel_id: 'destination-2', message_id: 'message-2', ok: true,
    }) }),
    call({ resultPreview: JSON.stringify({ channel_id: 'source', message_id: 'same', ok: true }) }),
    call({ failed: true, resultPreview: JSON.stringify({ channel_id: 'destination-3', message_id: 'failed', ok: true }) }),
    call({ name: 'vecgrep.search', resultPreview: JSON.stringify({ channel_id: 'destination-4', message_id: 'unrelated', ok: true }) }),
    call(),
  ], 'source')

  assert.deepEqual(posts, [
    { channelId: 'destination', messageId: 'message-1' },
    { channelId: 'destination-2', messageId: 'message-2' },
  ])
})

test('crosspost receipt suppression requires a real crosspost', () => {
  const posts = [{ channelId: 'destination', messageId: 'message-1' }]
  const receipt = 'Replied in `chat` (`123456789012345678`), message `123456789012345679`.'

  assert.equal(shouldQuietCrosspostReceipt(CROSSPOST_DONE_SIGNAL, posts), true)
  assert.equal(shouldQuietCrosspostReceipt(CROSSPOST_DONE_SIGNAL, []), true)
  assert.equal(shouldQuietCrosspostReceipt(receipt, posts), true)
  assert.equal(shouldQuietCrosspostReceipt(receipt, []), false)
  assert.equal(shouldQuietCrosspostReceipt('The detailed answer is also in #chat.', posts), false)
})
