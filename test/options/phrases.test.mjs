import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { sentence, withReason } from '../../src/options_ui/model/phrases.ts'

describe('phrases', () => {
  test('a clause starts a sentence with a capital, and is otherwise left as it is', () => {
    assert.equal(sentence('off for now: one job at a time, and AO3 is caching'), 'Off for now: one job at a time, and AO3 is caching')
    assert.equal(sentence(''), '')
  })

  test('a control\'s tooltip says what it does, then why it is off', () => {
    const label = 'Cache this list\'s works'
    const reason = 'off while this list is caching'
    const tooltip = withReason(label, reason)
    assert.ok(tooltip.startsWith(label), 'what it does comes first')
    assert.ok(tooltip.endsWith(reason), 'then why it is off')
    assert.equal(withReason(label, null), label)
    assert.equal(withReason(label, undefined), label)
  })
})
