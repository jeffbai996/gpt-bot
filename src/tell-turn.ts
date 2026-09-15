// A turn opened by a delivered bot-to-bot tell must not send one.
//
// The owner's relay tooling puts a deliver-or-drop card in front of them; the
// tap posts a signed relay whose payload opens with TELL_MARK. Claude bots
// refuse a tell inside such a turn with a PreToolUse hook that reads their
// transcript. gpt has no hooks, so it leaves a marker file in its state dir
// instead and the owner's CLI reads it before posting a card:
// {"until": <epoch seconds>}. Armed with a TTL rather than cleared at turn end,
// because the turn is queued and may run after dispatch returns; a tell gpt
// wants to send in the meantime is told to try again later, which is the
// failure direction we want (Jeff 2026-09-15: no bot loops).
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const TELL_MARK = '⟦bot-relay⟧'
export const TELL_TURN_FILE = '.tell_turn'
export const TELL_TURN_TTL_MS = 20 * 60_000

export function isTellPayload(payload: string): boolean {
  return payload.trimStart().startsWith(TELL_MARK)
}

export class TellTurnMarker {
  constructor(
    private readonly stateDir: string,
    private readonly ttlMs = TELL_TURN_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  get file(): string {
    return path.join(this.stateDir, TELL_TURN_FILE)
  }

  /** Mark the state dir: a tell-originated turn is (about to be) running. */
  arm(): void {
    const until = (this.clock() + this.ttlMs) / 1000
    try {
      writeFileSync(this.file, JSON.stringify({ until }) + '\n', { mode: 0o600 })
    } catch {
      // Best effort: the owner's tap is the real gate; this only spares a card.
    }
  }

  /** Is a tell-originated turn still within its window? */
  active(): boolean {
    try {
      const until = Number(JSON.parse(readFileSync(this.file, 'utf8')).until)
      return Number.isFinite(until) && until * 1000 > this.clock()
    } catch {
      return false
    }
  }

  /** Remove an expired marker so the dir does not carry it forever. */
  sweep(): void {
    if (this.active()) return
    try { unlinkSync(this.file) } catch { /* already gone */ }
  }
}
