// Which codex-generated images have already reached Discord.
//
// The built-in `image_gen` tool writes into $CODEX_HOME/generated_images/<thread>/
// and the harvest in codex-chat.ts originally claimed anything written during
// the current turn. That covers "draw me a duck" and nothing else: asked to
// "attach the 3 images you made earlier", codex generates nothing, the mtime
// window matches nothing, and the reply once again names pictures Discord never
// shows (Jeff 2026-09-15).
//
// A clock was the wrong key. The real invariant is delivery, not recency:
// every image codex draws in a thread should reach the channel exactly once.
// So remember what has been sent instead of when it was made.
//
// Marked only after Discord accepts the upload, so a failed send is retried on
// the next turn rather than silently swallowed.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const STATE_DIR = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
const FILE = path.join(STATE_DIR, 'delivered-codex-images.json')

// A resumed thread can be months old. Delivering a backlog is the point, but
// resurrecting July's output into today's conversation is not.
export const BACKLOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
// Bounds the per-thread ledger so a long image-heavy thread cannot grow it
// without limit. Oldest entries fall off; re-delivering one is a cosmetic
// nuisance, an unbounded state file is not.
const MAX_REMEMBERED_PER_THREAD = 200

class DeliveredImages {
  private map = new Map<string, string[]>()
  private loaded = false

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, string[]>
      for (const [threadId, names] of Object.entries(raw)) {
        if (Array.isArray(names)) this.map.set(threadId, names.filter(n => typeof n === 'string'))
      }
    } catch { /* first run, or a corrupt ledger — an empty one is safe */ }
  }

  private save(): void {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 })
    } catch (e) {
      console.error('[codex-image] could not persist the delivery ledger:', e)
    }
  }

  /** Has this file already been sent to Discord? Keyed by basename: the
   * directory is fixed by thread id, and the names codex writes are uuids. */
  delivered(threadId: string, fileName: string): boolean {
    this.load()
    return this.map.get(threadId)?.includes(fileName) ?? false
  }

  /** Record an accepted upload. */
  mark(threadId: string, fileNames: string[]): void {
    if (!threadId || !fileNames.length) return
    this.load()
    const names = this.map.get(threadId) ?? []
    for (const name of fileNames) if (!names.includes(name)) names.push(name)
    this.map.set(threadId, names.slice(-MAX_REMEMBERED_PER_THREAD))
    this.save()
  }
}

export const deliveredImages = new DeliveredImages()
