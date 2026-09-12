import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  completionContinuationPrompt,
  isNonTerminalActionReply,
  MAX_COMPLETION_CONTINUATIONS,
  mergeCompletionReplies,
} from '../src/completion-gate.ts'

test('completion gate rejects the todo-pass progress final from the incident', () => {
  assert.equal(isNonTerminalActionReply(
    'Yep. I\'m treating it as a workflow pass. I\'m auditing the current task flow against it now.',
  ), true)
})

test('completion gate rejects common promises and ongoing execution claims', () => {
  for (const reply of [
    'On it.',
    'I\'ll fix that next.',
    'I am working through the deployment now.',
    'We\'re running the full test suite.',
    'Next I\'m going to inspect the live bundle.',
  ]) assert.equal(isNonTerminalActionReply(reply), true, reply)
})

test('completion gate accepts completed work, answers, and concrete blockers', () => {
  for (const reply of [
    'Done. The completion gate now resumes progress-only finals; 472 tests passed.',
    'The service is active and the deployed SHA matches origin.',
    'The auditing pass is complete and the todo spec is saved.',
    'The two channels have separate context windows.',
    'Honestly? I wouldn\'t count on it.',
    'The outcome depends on it being available.',
    'The phrase "on it" is too broad for substring matching.',
    'Blocked: the migration needs Jeff to choose which real database is authoritative.',
  ]) assert.equal(isNonTerminalActionReply(reply), false, reply)
})

test('completion gate only treats on-it acknowledgements as standalone status lines', () => {
  assert.equal(isNonTerminalActionReply('On it.'), true)
  assert.equal(isNonTerminalActionReply('Background context.\n\nOn it!'), true)
})

test('completion continuations preserve every non-empty reply in order', () => {
  assert.equal(mergeCompletionReplies([
    'A substantive first answer.',
    '  ',
    'A useful continuation with a correction.',
  ]), 'A substantive first answer.\n\nA useful continuation with a correction.')
})

test('completion continuation preserves one bounded harness policy', () => {
  assert.equal(MAX_COMPLETION_CONTINUATIONS, 2)
  const prompt = completionContinuationPrompt(1)
  assert.match(prompt, /same requested task/i)
  assert.match(prompt, /do not repeat/i)
  assert.match(prompt, /completed result|concrete blocker/i)
})
