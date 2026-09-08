import assert from 'node:assert/strict'
import test from 'node:test'
import { scanOutboundFiles, MAX_UPLOAD_BYTES } from '../src/outbound-files.ts'

const HOME = '/home/alice'
const SHOTS = ['/tmp', HOME, `${HOME}/.cache/computer-use`]

/** A fake filesystem: absolute path -> size in bytes. */
function deps(fs: Record<string, number>, maxBytes?: number) {
  return {
    shotDirs: SHOTS,
    isFile: (p: string) => Object.prototype.hasOwnProperty.call(fs, p),
    sizeOf: (p: string) => fs[p] ?? 0,
    join: (a: string, b: string) => `${a}/${b}`,
    basename: (p: string) => p.split('/').pop() as string,
    isAbsolute: (p: string) => p.startsWith('/'),
    maxBytes,
  }
}

test('a .md named by absolute path in a markdown link is attached', () => {
  const fsx = { '/home/alice/letter.md': 200 }
  const r = scanOutboundFiles('Here it is: [the letter](/home/alice/letter.md)', deps(fsx))
  assert.deepEqual(r.files, ['/home/alice/letter.md'])
  assert.equal(r.reply, 'Here it is: the letter')   // link collapses to its label
})

test('a backticked absolute .md is attached and keeps its prose', () => {
  const fsx = { '/home/alice/x/plan.md': 10 }
  const r = scanOutboundFiles('saved at `/home/alice/x/plan.md` for you', deps(fsx))
  assert.deepEqual(r.files, ['/home/alice/x/plan.md'])
  assert.match(r.reply, /saved at `\/home\/alice\/x\/plan\.md` for you/)
})

test('a BARE .md mention is never attached and never edited out', () => {
  // The whole reason documents get stricter rules than images: this sentence
  // is prose, and $HOME really does contain a README.md.
  const fsx = { '/home/alice/README.md': 50 }
  const r = scanOutboundFiles('check README.md for the details', deps(fsx))
  assert.deepEqual(r.files, [])
  assert.equal(r.reply, 'check README.md for the details')
})

test('a relative document path is not resolved against $HOME', () => {
  const fsx = { '/home/alice/notes.md': 50 }
  const r = scanOutboundFiles('see `notes.md`', deps(fsx))
  assert.deepEqual(r.files, [])
})

test('images still attach from a bare name via the screenshot dirs', () => {
  const fsx = { '/home/alice/.cache/computer-use/shot.png': 900 }
  const r = scanOutboundFiles('took shot.png just now', deps(fsx))
  assert.deepEqual(r.files, ['/home/alice/.cache/computer-use/shot.png'])
  assert.equal(r.reply, 'took  just now'.replace(/\s+$/, ''))
})

test('an oversized file is refused rather than thrown at Discord', () => {
  const fsx = { '/home/alice/huge.pdf': MAX_UPLOAD_BYTES + 1 }
  const r = scanOutboundFiles('[big](/home/alice/huge.pdf)', deps(fsx))
  assert.deepEqual(r.files, [])
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].reason, 'too-large')
  assert.match(r.reply, /\[big\]/)          // text untouched, so the path survives
})

test('a document that does not exist leaves the text alone', () => {
  const r = scanOutboundFiles('[gone](/home/alice/nope.md)', deps({}))
  assert.deepEqual(r.files, [])
  assert.equal(r.reply, '[gone](/home/alice/nope.md)')
})

test('mixed image and document in one reply', () => {
  const fsx = { '/tmp/a.png': 10, '/home/alice/b.md': 10 }
  const r = scanOutboundFiles('shot /tmp/a.png and [doc](/home/alice/b.md)', deps(fsx))
  assert.deepEqual(r.files.sort(), ['/home/alice/b.md', '/tmp/a.png'])
})

test('duplicates collapse and the count is capped', () => {
  const fsx: Record<string, number> = {}
  for (let i = 0; i < 14; i++) fsx[`/tmp/f${i}.png`] = 1
  const reply = Array.from({ length: 14 }, (_, i) => `/tmp/f${i}.png /tmp/f${i}.png`).join(' ')
  const r = scanOutboundFiles(reply, deps(fsx))
  assert.equal(r.files.length, 10)
  assert.equal(new Set(r.files).size, 10)
})

test('a reply with no files is returned untouched', () => {
  const original = 'no paths here at all'
  const r = scanOutboundFiles(original, deps({}))
  assert.equal(r.reply, original)
  assert.deepEqual(r.files, [])
})
