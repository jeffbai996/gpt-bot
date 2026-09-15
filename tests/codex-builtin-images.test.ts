import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// readBuiltinGeneratedImages resolves CODEX_HOME at module load, so point it at
// a scratch directory before the import.
const HOME = await mkdtemp(path.join(os.tmpdir(), 'codex-home-test-'))
process.env.CODEX_HOME = HOME
const { readBuiltinGeneratedImages } = await import('../src/codex-chat.ts')

const THREAD = '01a0468c-d060-7722-bf01-83fd43f72d8e'
const dir = path.join(HOME, 'generated_images', THREAD)
await mkdir(dir, { recursive: true })

const write = async (name: string, atMs: number) => {
  const file = path.join(dir, name)
  await writeFile(file, 'png bytes')
  await utimes(file, new Date(atMs), new Date(atMs))
  return file
}

const TURN_START = 1_757_000_000_000

test('attaches only the images this turn drew, oldest first', async () => {
  // A resumed thread's directory is full of earlier turns' ducks.
  await write('exec-old.png', TURN_START - 3_600_000)
  const second = await write('exec-second.png', TURN_START + 20_000)
  const first = await write('exec-first.png', TURN_START + 5_000)
  await write('notes.txt', TURN_START + 5_000)

  assert.deepEqual(await readBuiltinGeneratedImages(THREAD, TURN_START), [first, second])
})

test('tolerates the turn clock starting a beat before codex writes', async () => {
  const early = await write('exec-early.png', TURN_START - 800)
  const found = await readBuiltinGeneratedImages(THREAD, TURN_START)
  assert.ok(found.includes(early), 'a sub-second-early mtime is still this turn')
})

test('a thread that never drew anything yields nothing, not an error', async () => {
  assert.deepEqual(await readBuiltinGeneratedImages('thread-with-no-directory', TURN_START), [])
})

test('codex-owned output is attached but never swept up as temporary', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/codex-chat.ts', import.meta.url), 'utf8')
  assert.match(source, /const generatedFiles = \[\.\.\.rolloutImages, \.\.\.builtinImages\]/)
  // Deleting these would remove files from inside CODEX_HOME.
  assert.match(source, /temporaryFiles: rolloutImages,/)
  assert.doesNotMatch(source, /temporaryFiles: generatedFiles,/)
})
