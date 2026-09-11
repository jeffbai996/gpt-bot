import assert from 'node:assert/strict'
import fs from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { codeBlock } from 'discord.js'

test('global queue notice is a fenced readout with unchanged counters', () => {
  const source = fs.readFileSync(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const expression = source.match(/codeBlock\('text', `⏳ queued globally[^`]+`\)/)?.[0]
  assert.ok(expression, 'the queue reply must use a text code block')
  const content = runInNewContext(expression, {
    codeBlock,
    position: 1,
    MAX_GLOBAL_TURNS: 2,
    globalTurns: { snapshot: () => ({ running: 0 }) },
  })
  assert.equal(content, '```text\n⏳ queued globally · position 1 · 0/2 running\n```')
})
