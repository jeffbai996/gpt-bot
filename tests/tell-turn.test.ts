import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TellTurnMarker, TELL_MARK, TELL_TURN_FILE, isTellPayload } from '../src/tell-turn.ts'

function dir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'tell-turn-'))
}

test('a relay payload that opens with the mark is a tell', () => {
  assert.equal(isTellPayload(`${TELL_MARK} One-off message from a sibling bot ...`), true)
  assert.equal(isTellPayload('You chose option 1: proceed'), false)
  assert.equal(isTellPayload(`  ${TELL_MARK} leading space`), true)
})

test('arming writes an until the relay CLI can read', () => {
  let now = 1_000_000
  const marker = new TellTurnMarker(dir(), 60_000, () => now)
  assert.equal(marker.active(), false)
  marker.arm()
  const raw = JSON.parse(readFileSync(marker.file, 'utf8'))
  assert.equal(raw.until, (now + 60_000) / 1000)
  assert.equal(marker.active(), true)
  now += 60_001
  assert.equal(marker.active(), false)
})

test('sweep removes only an expired marker', () => {
  let now = 5_000
  const marker = new TellTurnMarker(dir(), 1_000, () => now)
  marker.arm()
  marker.sweep()
  assert.equal(existsSync(path.join(path.dirname(marker.file), TELL_TURN_FILE)), true)
  now += 2_000
  marker.sweep()
  assert.equal(existsSync(marker.file), false)
})

test('an unreadable marker is not active', () => {
  const marker = new TellTurnMarker(path.join(dir(), 'missing'))
  assert.equal(marker.active(), false)
  marker.sweep()   // must not throw
})
