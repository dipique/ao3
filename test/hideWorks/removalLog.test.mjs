import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { describeBlurb, describeRemoval, OUTCOMES } from '../../src/content_script/removalLog.ts'

const work = { id: '123', name: 'A Title' }

/** Assert `line` carries each of `facts`, in the order given. */
function carries(line, ...facts) {
  let from = 0
  for (const fact of facts) {
    const at = line.indexOf(fact, from)
    assert.ok(at >= 0, `${JSON.stringify(line)} should give ${JSON.stringify(fact)} after position ${from}`)
    from = at + fact.length
  }
}

describe('describeRemoval', () => {
  test('names the work, what happened to it, and the reason', () => {
    const subject = { work, series: [] }
    const line = describeRemoval('hide', subject, {
      'Additional Tags': [{ value: 'Torture', rule: 'Tag contains "tort"' }],
    })
    carries(line, describeBlurb(subject), OUTCOMES.hide, 'Additional Tags', 'Torture', 'Tag contains "tort"')
  })

  test('a work is named by its id and its title', () => {
    carries(describeBlurb({ work, series: [] }), '123', 'A Title')
  })

  test('says how the work left the page', () => {
    const reasons = { Author: [{ value: 'someone', rule: 'Author "someone"' }] }
    const subject = { work, series: [] }
    const removals = ['hide', 'collapse', 'drop', 'exclude']
    for (const removal of removals)
      carries(describeRemoval(removal, subject, reasons), describeBlurb(subject), OUTCOMES[removal])
    assert.equal(new Set(removals.map(removal => OUTCOMES[removal])).size, removals.length, 'each way is told apart')
  })

  test('lists every value of every group, in order, on one line', () => {
    const line = describeRemoval('hide', { work, series: [] }, {
      'Relationship': [
        { value: 'A/B', rule: 'Relationship contains "A/"' },
        { value: 'A/C', rule: 'Relationship contains "A/"' },
      ],
      'Too many fandoms': [{ value: '9 fandoms', rule: 'More than 7 fandoms' }],
    })
    carries(line, 'Relationship', 'A/B', 'Relationship contains "A/"', 'A/C', 'Relationship contains "A/"', 'Too many fandoms', '9 fandoms', 'More than 7 fandoms')
    assert.ok(!line.includes('\n'), line)
  })

  test('keeps a multi-line rule on one line', () => {
    const line = describeRemoval('collapse', { work, series: [] }, {
      Ongoing: [{ value: 'A Title', rule: 'Read up to chapter 3 of 5\nWaiting until 2026-10-10' }],
    })
    assert.ok(!line.includes('\n'), line)
    carries(line, 'Ongoing', 'Read up to chapter 3 of 5', 'Waiting until 2026-10-10')
  })

  test('names a series blurb by its series', () => {
    const subject = { series: [{ id: '45', name: 'A Series' }, { id: '46', name: 'Another' }] }
    carries(describeBlurb(subject), '45', 'A Series')
    assert.ok(!describeBlurb(subject).includes('Another'), 'by the first of its series')
    const line = describeRemoval('hide', subject, {
      Series: [{ value: 'A Series', rule: 'Series id 45' }],
    })
    carries(line, describeBlurb(subject), OUTCOMES.hide, 'Series id 45')
  })

  test('still says something about a blurb with neither a work nor a series', () => {
    const subject = { series: [] }
    assert.ok(describeBlurb(subject).trim(), 'the blurb is still named')
    const line = describeRemoval('hide', subject, {
      Author: [{ value: 'someone', rule: 'Author "someone"' }],
    })
    carries(line, describeBlurb(subject), OUTCOMES.hide, 'Author', 'someone', 'Author "someone"')
  })

  test('a group with nothing in it is no reason, as none is', () => {
    const subject = { work, series: [] }
    const none = describeRemoval('hide', subject, {})
    carries(none, describeBlurb(subject), OUTCOMES.hide)
    assert.equal(describeRemoval('hide', subject, { Tag: [] }), none)
  })
})
