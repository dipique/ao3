import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { mergedIntoOriginalWork, ORIGINAL_WORK } from '../../src/content_script/fandomSynonyms.ts'

const ORIGINAL_WORK_ID = 2692

describe('mergedIntoOriginalWork', () => {
  test('a differently named fandom that resolves to Original Work is one AO3 merged into it', () => {
    assert.equal(mergedIntoOriginalWork('GoneWildAudio (r/gonewildaudio)', ORIGINAL_WORK_ID, ORIGINAL_WORK_ID), true)
  })

  test('Original Work itself is not, in any casing', () => {
    assert.equal(mergedIntoOriginalWork(ORIGINAL_WORK, ORIGINAL_WORK_ID, ORIGINAL_WORK_ID), false)
    assert.equal(mergedIntoOriginalWork('original work', ORIGINAL_WORK_ID, ORIGINAL_WORK_ID), false)
    assert.equal(mergedIntoOriginalWork(' Original Work ', ORIGINAL_WORK_ID, ORIGINAL_WORK_ID), false)
  })

  test('a fandom resolving to any other canonical is not', () => {
    assert.equal(mergedIntoOriginalWork('HP', 136512, ORIGINAL_WORK_ID), false)
  })

  test('nothing is, while the fandom\'s id is unknown', () => {
    assert.equal(mergedIntoOriginalWork('GoneWildAudio (r/gonewildaudio)', null, ORIGINAL_WORK_ID), false)
  })

  test('nothing is, while Original Work\'s own id is unknown', () => {
    assert.equal(mergedIntoOriginalWork('GoneWildAudio (r/gonewildaudio)', ORIGINAL_WORK_ID, null), false)
  })
})
