import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { AccessManager } from '../src/access.ts'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-access-'))
  process.env.GPT_STATE_DIR = tmpDir
})

test('access: canHandle requires user allowlist + channel enabled', async () => {
  const a = new AccessManager()
  await a.load()

  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: false }), false)

  await a.allowUser('u1')
  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: false }), false, 'channel still disabled')

  await a.setChannel('c1', true, false)
  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: false }), true)
})

test('access: requireMention=true gates non-mentions', async () => {
  const a = new AccessManager()
  await a.load()
  await a.allowUser('u1')
  await a.setChannel('c1', true, true)

  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: false }), false)
  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: true }), true)
})

test('access: setChannelFlags preserves enabled/requireMention', async () => {
  const a = new AccessManager()
  await a.load()
  await a.allowUser('u1')
  await a.setChannel('c1', true, true)
  await a.setChannelFlags('c1', { model: 'o3', reasoning: 'high' })

  const flags = a.channelFlags('c1')
  assert.equal(flags.model, 'o3')
  assert.equal(flags.reasoning, 'high')
  assert.equal(a.canHandle({ channelId: 'c1', userId: 'u1', isMention: true }), true)
})

test('access: model=null clears per-channel override', async () => {
  const a = new AccessManager()
  await a.load()
  await a.setChannel('c1', true, false, { model: 'gpt-5.4-mini' })
  assert.equal(a.channelFlags('c1').model, 'gpt-5.4-mini')

  await a.setChannelFlags('c1', { model: null })
  assert.equal(a.channelFlags('c1').model, null)
})
