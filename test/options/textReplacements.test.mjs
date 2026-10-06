import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { MATCH_CASING_OFF, matchCasingOff } from '../../src/options_ui/model/textReplacements.ts'

describe('matchCasingOff', () => {
  test('Match casing is live on a rule that ignores case', () => {
    assert.equal(matchCasingOff({ caseSensitive: false }), null)
    assert.equal(matchCasingOff({}), null, 'a rule stored without the flag ignores case')
  })

  test('under Case sensitive it is inert, saying why, whatever its own value', () => {
    assert.equal(MATCH_CASING_OFF, 'Off while Case sensitive is on')
    assert.equal(matchCasingOff({ caseSensitive: true, matchCasing: true }), MATCH_CASING_OFF)
    assert.equal(matchCasingOff({ caseSensitive: true, matchCasing: false }), MATCH_CASING_OFF)
  })
})
