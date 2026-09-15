import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Both modules resolve their directories at load time, so point CODEX_HOME and
// the bot state dir at scratch space before importing them.
const HOME = await mkdtemp(path.join(os.tmpdir(), 'codex-home-test-'))
const STATE = await mkdtemp(path.join(os.tmpdir(), 'gpt-state-test-'))
process.env.CODEX_HOME = HOME
process.env.GPT_STATE_DIR = STATE
const { readBuiltinGeneratedImages } = await import('../src/codex-chat.ts')
const { deliveredImages, BACKLOG_MAX_AGE_MS } = await import('../src/delivered-images.ts')

const THREAD = '01a0468c-d060-7722-bf01-83fd43f72d8e'
const dir = path.join(HOME, 'generated_images', THREAD)
await mkdir(dir, { recursive: true })

const NOW = 1_757_000_000_000
const write = async (name: string, atMs: number) => {
  const file = path.join(dir, name)
  await writeFile(file, 'png bytes')
  await utimes(file, new Date(atMs), new Date(atMs))
  return file
}

test('attaches every undelivered image, oldest first', async () => {
  const second = await write('exec-second.png', NOW - 20_000)
  const first = await write('exec-first.png', NOW - 60_000)
  await write('notes.txt', NOW - 10_000)

  assert.deepEqual(await readBuiltinGeneratedImages(THREAD, NOW), [first, second])
})

test('an image made yesterday still goes out when it never reached Discord', async () => {
  // The 2026-09-15 case: "attach the 3 images you made earlier". codex draws
  // nothing this turn, so a turn-scoped mtime window would return empty.
  const yesterday = await write('exec-duck.png', NOW - 20 * 60 * 60 * 1000)
  assert.ok((await readBuiltinGeneratedImages(THREAD, NOW)).includes(yesterday))
})

test('a delivered image is never sent twice', async () => {
  const before = await readBuiltinGeneratedImages(THREAD, NOW)
  assert.ok(before.length >= 3)
  deliveredImages.mark(THREAD, before.map(file => path.basename(file)))
  assert.deepEqual(await readBuiltinGeneratedImages(THREAD, NOW), [])
  // And the record survives a restart.
  const ledger = JSON.parse(await readFile(path.join(STATE, 'delivered-codex-images.json'), 'utf8'))
  assert.deepEqual(ledger[THREAD].sort(), before.map(file => path.basename(file)).sort())
})

test('a months-old backlog is not resurrected into today', async () => {
  await write('exec-ancient.png', NOW - BACKLOG_MAX_AGE_MS - 1_000)
  assert.deepEqual(await readBuiltinGeneratedImages(THREAD, NOW), [])
})

test('a thread that never drew anything yields nothing, not an error', async () => {
  assert.deepEqual(await readBuiltinGeneratedImages('thread-with-no-directory', NOW), [])
})

test('delivery is recorded only after Discord accepts the upload', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const send = source.indexOf('bottomContentMessage = await message.channel.send({')
  const mark = source.indexOf('deliveredImages.mark(result.threadId', send)
  const catchAt = source.indexOf('} catch (e) {', send)
  assert.ok(send > 0 && mark > send, 'the ledger is written after the send call')
  assert.ok(mark < catchAt, 'and inside the try, so a failed send retries next turn')
})

test('codex-owned output is attached but never swept up as temporary', async () => {
  const source = await readFile(new URL('../src/codex-chat.ts', import.meta.url), 'utf8')
  assert.match(source, /const generatedFiles = \[\.\.\.rolloutImages, \.\.\.builtinImages\]/)
  // Deleting these would remove files from inside CODEX_HOME.
  assert.match(source, /temporaryFiles: rolloutImages,/)
  assert.doesNotMatch(source, /temporaryFiles: generatedFiles,/)
})
