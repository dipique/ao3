import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { estimatedHeights, ROW_ESTIMATE, rowOffset, rowWindow, sameWindow } from '../../src/options_ui/model/rowWindow.ts'

const even = (count, height = 32) => Array.from({ length: count }).fill(height)
const total = heights => heights.reduce((sum, h) => sum + h, 0)
const OPTIONS = { overscan: 4, chunk: 5 }

/** The window's rows and the room before and after them come to the whole list's height. */
function adds(heights, window) {
  assert.equal(window.before + total(heights.slice(window.start, window.end)) + window.after, total(heights))
}

describe('rowWindow', () => {
  test('an empty list draws nothing', () => {
    assert.deepEqual(rowWindow([], 0, 300, OPTIONS), { start: 0, end: 0, before: 0, after: 0 })
  })

  test('a list shorter than its view draws every row, with no room before or after', () => {
    assert.deepEqual(rowWindow(even(6), 0, 300, OPTIONS), { start: 0, end: 6, before: 0, after: 0 })
  })

  test('at the top, the rows in view and some past them, rounded out to whole chunks', () => {
    // 100 px shows rows 0-3; four more past them reaches row 7, and the chunk of five ends at 10.
    const heights = even(100)
    const window = rowWindow(heights, 0, 100, OPTIONS)
    assert.deepEqual([window.start, window.end, window.before], [0, 10, 0])
    adds(heights, window)
  })

  test('part way down, the rows around the view, the rows above it stood in for by their height', () => {
    // Scrolled to row 50; 100 px shows rows 50-53; four either side is 46-57, rounded out to 45-60.
    const heights = even(100)
    const window = rowWindow(heights, 50 * 32, 100, OPTIONS)
    assert.deepEqual([window.start, window.end, window.before], [45, 60, 45 * 32])
    adds(heights, window)
  })

  test('at the end, the last rows, with no room after them', () => {
    const heights = even(100)
    const window = rowWindow(heights, total(heights) - 100, 100, OPTIONS)
    assert.equal(window.end, 100)
    assert.equal(window.after, 0)
    adds(heights, window)
  })

  test('rows of different heights are counted at their own', () => {
    const heights = [...even(10, 20), ...even(10, 60)]
    // 200 px down is the end of the short rows; 61 px shows row 10 and the top of row 11.
    const window = rowWindow(heights, 200, 61, { overscan: 0, chunk: 1 })
    assert.deepEqual([window.start, window.end, window.before], [10, 12, 200])
    adds(heights, window)
  })

  test('the window holds still while the view moves within a chunk, so the rows aren\'t drawn again for every step', () => {
    const heights = even(100)
    assert.ok(sameWindow(rowWindow(heights, 50 * 32, 100, OPTIONS), rowWindow(heights, 51 * 32, 100, OPTIONS)))
    assert.ok(!sameWindow(rowWindow(heights, 50 * 32, 100, OPTIONS), rowWindow(heights, 60 * 32, 100, OPTIONS)))
  })

  test('a view scrolled past the end, as the list shrinks under it, draws the last rows', () => {
    const heights = even(20)
    const window = rowWindow(heights, 5000, 100, OPTIONS)
    assert.equal(window.end, 20)
    assert.ok(window.start < 20)
    adds(heights, window)
  })
})

describe('sameWindow', () => {
  test('no window is the same as no window, and not as one', () => {
    assert.ok(sameWindow(null, null))
    assert.ok(!sameWindow(null, { start: 0, end: 0, before: 0, after: 0 }))
  })
})

describe('rowOffset', () => {
  test('how far down a row starts', () => {
    assert.equal(rowOffset([10, 20, 30], 0), 0)
    assert.equal(rowOffset([10, 20, 30], 2), 30)
  })
})

describe('estimatedHeights', () => {
  test('a measured row is its measure; one not yet drawn is the measured rows\' average', () => {
    assert.deepEqual(estimatedHeights(['a', 'b', 'c'], new Map([['a', 30], ['c', 50]])), [30, 40, 50])
  })

  test('with nothing measured yet, every row is the estimate', () => {
    assert.deepEqual(estimatedHeights([1, 2], new Map()), [ROW_ESTIMATE, ROW_ESTIMATE])
  })
})
