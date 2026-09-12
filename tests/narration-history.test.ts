import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NarrationHistory, narrationBlocks } from '../src/narration-history.ts'

test('demotes every update in order and keeps the last one on completion', async () => {
  const history = new NarrationHistory()
  const saved: string[] = []
  const retire = async (text: string) => { saved.push(text) }
  history.accept('first')
  await history.advance(retire)
  assert.equal(history.current, 'first')
  history.accept('second')
  history.accept('third')
  await history.advance(retire)
  assert.deepEqual(saved, ['first', 'second'])
  assert.equal(history.current, 'third')
  await history.finish(retire)
  await history.finish(retire)
  assert.deepEqual(saved, ['first', 'second', 'third'])
})

test('filters image request envelopes and duplicate progress', async () => {
  const history = new NarrationHistory()
  assert.equal(history.accept('{"image_request":{"prompt":"secret draft"}}'), false)
  assert.equal(history.accept('```json\n{"image_request":'), false)
  history.accept('hello')
  assert.equal(history.accept('hello'), false)
  const saved: string[] = []
  await history.finish(async text => { saved.push(text) })
  assert.deepEqual(saved, ['hello'])
})

test('narration preserves its original text formatting without added fences', () => {
  const text = '**Checking** the render.\n\nKeeping `inline code` and ordinary prose.'
  assert.deepEqual(narrationBlocks(text), ['>>> ' + text])
  const long = 'Some narration. '.repeat(400)
  const blocks = narrationBlocks(long)
  assert.ok(blocks.length > 1)
  assert.ok(blocks.every(block => block.length <= 1900))
  assert.equal(blocks.map(block => block.slice(4)).join(''), long)
})

test('failed demotion remains retryable', async () => {
  const history = new NarrationHistory()
  history.accept('first')
  await assert.rejects(history.finish(async () => { throw Error('offline') }))
  const saved: string[] = []
  await history.finish(async text => { saved.push(text) })
  assert.deepEqual(saved, ['first'])
})

test('production demotion edits the original message and removes it from crash cleanup', async () => {
  const { readFile } = await import('node:fs/promises')
  const { transpile } = await import('typescript')
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  const retireNarration = async')
  const end = source.indexOf('\n  // Serialize and coalesce', start)
  const contents = new Map([['original', 'thinking: first']])
  const tracked = new Set(['original'])
  const prior = { id: 'original', edit: async ({ content }: { content: string }) => { contents.set('original', content) } }
  const channel = {
    isSendable: () => true,
    send: async ({ content }: { content: string }) => { contents.set(`new-${contents.size}`, content) },
  }
  // Execute the actual production callback with a Discord transport double.
  const factory = new Function('message', 'pendingPlaceholders', 'narrationBlocks', 'prior', transpile(`
    let workMessage = prior, narrationMessageId = prior.id, targetMessage = null;
    let placeholderId = prior.id, lastEditedText = 'old';
    ${source.slice(start, end)}
    return { retireNarration, current: () => workMessage };
  `))
  const owner = factory({ channel }, { untrack: (id: string) => tracked.delete(id) }, narrationBlocks, prior)
  const history = new NarrationHistory()
  history.accept('first')
  await history.advance(owner.retireNarration)
  history.accept('second')
  await history.advance(owner.retireNarration)
  assert.equal(contents.get('original'), '>>> first')
  assert.equal(owner.current(), null)
  assert.equal(tracked.size, 0)
  await history.finish(owner.retireNarration)
  assert.deepEqual([...contents.values()], ['>>> first', '>>> second'])
})

test('completion racing a slow edit does not demote the same update twice', async () => {
  const history = new NarrationHistory()
  const saved: string[] = []
  history.accept('first')
  await history.advance(async () => {})
  history.accept('second')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const retire = async (text: string) => { await gate; saved.push(text) }
  const render = history.advance(retire)
  const finish = history.finish(retire)
  release()
  await Promise.all([render, finish])
  assert.deepEqual(saved, ['first', 'second'])
})

test('authoritative final answer is not retained from pending or displayed progress', async () => {
  for (const rendered of [false, true]) {
    const history = new NarrationHistory()
    const saved: string[] = []
    const retire = async (text: string) => { saved.push(text) }
    history.accept('Checking the result')
    await history.advance(retire)
    history.accept('The final answer')
    if (rendered) await history.advance(retire)
    await history.finish(retire, '  The final answer  ')
    await history.finish(retire)
    assert.deepEqual(saved, ['Checking the result'])
  }
})
