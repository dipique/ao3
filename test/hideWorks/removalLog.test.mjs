import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { describeRemoval } from '../../src/content_script/removalLog.ts'

const work = { id: '123', name: 'A Title' }

describe('describeRemoval', () => {
  test('names the work, what happened to it, and the reason', () => {
    const line = describeRemoval('hide', { work, series: [] }, {
      'Additional Tags': [{ value: 'Torture', rule: 'Tag contains "tort"' }],
    })
    assert.equal(line, 'Work 123 "A Title" hidden — Additional Tags: "Torture" (Tag contains "tort")')
  })

  test('says how the work left the page', () => {
    const reasons = { Author: [{ value: 'someone', rule: 'Author "someone"' }] }
    const subject = { work, series: [] }
    assert.match(describeRemoval('hide', subject, reasons), /^Work 123 "A Title" hidden — /)
    assert.match(describeRemoval('collapse', subject, reasons), /^Work 123 "A Title" collapsed — /)
    assert.match(describeRemoval('drop', subject, reasons), /^Work 123 "A Title" left out of the results — /)
    assert.match(describeRemoval('exclude', subject, reasons), /^Work 123 "A Title" excluded by the view's filter — /)
  })

  test('separates the values in one group with commas and the groups with bars', () => {
    const line = describeRemoval('hide', { work, series: [] }, {
      Relationship: [
        { value: 'A/B', rule: 'Relationship contains "A/"' },
        { value: 'A/C', rule: 'Relationship contains "A/"' },
      ],
      Language: [{ value: 'Deutsch', rule: 'Language is "Deutsch"' }],
    })
    assert.equal(
      line,
      'Work 123 "A Title" hidden — Relationship: "A/B" (Relationship contains "A/"), "A/C" (Relationship contains "A/")'
      + ' | Language: "Deutsch" (Language is "Deutsch")',
    )
  })

  test('keeps a multi-line rule on one line', () => {
    const line = describeRemoval('collapse', { work, series: [] }, {
      Ongoing: [{ value: 'A Title', rule: 'Read up to chapter 3 of 5\nWaiting until 2026-10-10' }],
    })
    assert.equal(
      line,
      'Work 123 "A Title" collapsed — Ongoing: "A Title" (Read up to chapter 3 of 5; Waiting until 2026-10-10)',
    )
  })

  test('names a series blurb by its series', () => {
    const line = describeRemoval('hide', { series: [{ id: '45', name: 'A Series' }] }, {
      Series: [{ value: 'A Series', rule: 'Series id 45' }],
    })
    assert.equal(line, 'Series 45 "A Series" hidden — Series: "A Series" (Series id 45)')
  })

  test('still says something about a blurb with neither a work nor a series', () => {
    const line = describeRemoval('hide', { series: [] }, {
      Author: [{ value: 'someone', rule: 'Author "someone"' }],
    })
    assert.equal(line, 'Unlinked blurb hidden — Author: "someone" (Author "someone")')
  })

  test('says so when there is no reason to give', () => {
    assert.equal(describeRemoval('hide', { work, series: [] }, {}), 'Work 123 "A Title" hidden — no reason recorded')
    assert.equal(
      describeRemoval('hide', { work, series: [] }, { Tag: [] }),
      'Work 123 "A Title" hidden — no reason recorded',
    )
  })
})
