import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transpile } from 'typescript'

for (const mode of ['live', 'collapse', 'on']) {
  test(`production ${mode} trace follows narration while keeping one active card`, async () => {
    const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
    const start = source.indexOf('  const rehomeLiveWorkBelowTrace =')
    const end = source.indexOf('  const flushLiveTrace =', start)
    const messages = new Map<string, any>()
    let next = 0
    const send = async (content: string) => {
      const row: any = {id: String(++next), content, channelId:'channel',
        delete: async () => { messages.delete(row.id) },
        edit: async (body: any) => { row.content = typeof body === 'string' ? body : body.content },
      }
      messages.set(row.id, row)
      return row
    }
    const trace = await send('```\nTool output\n```')
    await send('Earlier narration')
    const current = await send('Thinking: current narration')
    const registry = new Set([current.id])
    const factory = new Function('initialTrace','initialWork','flags','pendingPlaceholders','pendingFlush', transpile(`
      let targetMessage = null, liveUiClosed = false, workMessage = initialWork;
      let liveWorkRehomeTask = null, liveTraceRehomeTask = null, liveEditTask = null;
      let liveTraceMsgs = [initialTrace], liveTraceClosed = false;
      let liveTraceFlushTask = pendingFlush, liveTraceDirty = false;
      const flushLiveTrace = () => {};
      let lastEditedText = '', effortLabel = 'thinking', placeholderId = initialWork.id;
      let narrationMessageId = initialWork.id;
      const message = {channel: {id:'channel'}, id:'request'};
      const startSpinner = () => {}, queueLiveRender = () => {}, armTraceFailsafe = () => {};
      const isNewerDiscordMessage = (a, b) => BigInt(a) > BigInt(b);
      ${source.slice(start, end)}
      return {moveTrace: rehomeLiveTraceAtBottom, moveWork: rehomeLiveWorkBelowTrace,
        state: () => ({workMessage,liveTraceMsgs,narrationMessageId})};
    `))
    let release!: () => void
    const pendingFlush = new Promise<void>(resolve => { release = resolve })
    const owner = factory(trace, current, {trace:mode}, {
      untrack: (id:string) => registry.delete(id),
      track: (_channel:string,id:string) => registry.add(id),
    }, pendingFlush)
    const moving = owner.moveTrace({send}, current, true)
    await Promise.resolve()
    assert.equal(next, 3)
    trace.content = '```\nUpdated tool output\n```'
    release()
    await moving
    await owner.moveWork({send})
    const state = owner.state()
    assert.deepEqual([...messages.values()].map(m => m.content), [
      'Earlier narration', '```\nUpdated tool output\n```', 'Thinking: current narration',
    ])
    assert.equal(state.narrationMessageId, state.workMessage.id)
    assert.deepEqual([...registry], [state.workMessage.id])
    assert.equal(state.liveTraceMsgs.length, 1)
    // Repeating the old anchor cannot recreate the trace again.
    await owner.moveTrace({send}, current, true)
    assert.equal(messages.size, 3)
  })
}
