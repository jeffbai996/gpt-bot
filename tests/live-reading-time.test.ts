import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transpile } from 'typescript'
import { advanceLiveProgressDwell } from '../src/live-update.ts'

test('production redraw preserves narration for ten seconds after a slow Discord edit', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  const renderLiveNow = async')
  const end = source.indexOf('  const queueLiveRender', start)
  const edits: string[] = []
  const factory = new Function('advanceLiveProgressDwell', 'edit', transpile(`
    let workMessage = { id: 'work', edit }, liveUiClosed = false, liveEditTask = null;
    let liveProgressHoldUntil = 0, liveRenderDirty = false, lastEditedText = '';
    let lastLiveRenderAt = 0, lastRenderedProgressText = '', narrationMessageId = null;
    const flags = { thinking: 'live' };
    const narrationHistory = { current: '', advance: async () => {} };
    const retireNarration = () => {}, postPlaceholder = async () => {};
    const effortLabel = 'thinking', liveHeadline = '', liveReasoningTrace = [];
    let liveDetail = 'First narration';
    const liveFooter = '', spinnerGlyph = '*', spinnerDots = '...', liveCompacting = false;
    const formatLiveWorkMessage = options => options.detail;
    const awaitBounded = async task => { await task; return true; };
    const abandonWedgedPlaceholder = () => { throw Error('unexpected timeout'); };
    const message = { channel: { isSendable: () => false } };
    ${source.slice(start, end)}
    return { renderLiveNow, change: text => { liveDetail = text; },
      deadline: () => liveProgressHoldUntil, dirty: () => liveRenderDirty };
  `))
  const owner = factory(advanceLiveProgressDwell, async (text: string) => {
    // Discord acknowledgement is delayed, so reading time must start afterward.
    t.mock.timers.tick(2000)
    edits.push(text)
  })
  await owner.renderLiveNow()
  assert.equal(owner.deadline(), 13000)
  owner.change('Next narration')
  // Simulate a stale timer that was armed before the first edit completed.
  await owner.renderLiveNow()
  assert.deepEqual(edits, ['First narration'])
  assert.equal(owner.dirty(), true)
  t.mock.timers.tick(9999)
  await owner.renderLiveNow()
  assert.deepEqual(edits, ['First narration'])
  t.mock.timers.tick(1)
  await owner.renderLiveNow()
  assert.deepEqual(edits, ['First narration', 'Next narration'])
})

test('moving the work card uses the rendered narration rather than cached placeholder text', async () => {
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  const rehomeLiveWorkBelowTrace = async')
  const end = source.indexOf('  const rehomeLiveTraceAtBottom', start)
  const sent: string[] = []
  const factory = new Function('send', transpile(`
    let targetMessage = null, liveUiClosed = false, liveWorkRehomeTask = null, liveEditTask = null;
    let workMessage = { id: 'old', content: 'thinking...', delete: async () => {} };
    let narrationMessageId = 'old', placeholderId = 'old';
    const lastEditedText = 'Readable narration', effortLabel = 'thinking';
    const pendingPlaceholders = { track: () => {}, untrack: () => {} };
    const message = { channel: { id: 'channel' }, id: 'request' };
    const startSpinner = () => {}, queueLiveRender = () => {};
    ${source.slice(start, end)}
    return () => rehomeLiveWorkBelowTrace({ send });
  `))
  await factory(async (content: string) => {
    sent.push(content)
    return { id: 'new', content, delete: async () => {} }
  })()
  assert.deepEqual(sent, ['Readable narration'])
})

test('final handoff waits for a pending edit before measuring its reading time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  const settleLiveUi = async')
  const end = source.indexOf('  let interruptionRendered', start)
  const waits: number[] = []
  const factory = new Function('completeEdit', 'sleep', transpile(`
    let liveUiClosed = false, liveProgressHoldUntil = 0;
    const stopThinkingAnim = async () => {
      await completeEdit();
      liveProgressHoldUntil = Date.now() + 10000;
    };
    const narrationHistory = { finish: async () => {} }, retireNarration = () => {};
    ${source.slice(start, end)}
    return () => settleLiveUi(true, 'answer');
  `))
  await factory(async () => { t.mock.timers.tick(2000) }, async (ms: number) => { waits.push(ms) })()
  assert.deepEqual(waits, [10000])
})
