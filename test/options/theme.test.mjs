import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { shownTheme, toggledTheme } from '../../src/options_ui/model/theme.ts'

describe('shownTheme', () => {
  test('an explicit choice is the theme shown, whatever AO3 shows', () => {
    assert.equal(shownTheme({ chosen: 'light', current: 'dark' }), 'light')
    assert.equal(shownTheme({ chosen: 'dark', current: 'light' }), 'dark')
  })

  test('following AO3 shows the theme AO3 resolved to', () => {
    assert.equal(shownTheme({ chosen: 'inherit', current: 'light' }), 'light')
    assert.equal(shownTheme({ chosen: 'inherit', current: 'dark' }), 'dark')
  })
})

describe('toggledTheme', () => {
  test('chooses the opposite of an explicit theme', () => {
    assert.equal(toggledTheme({ chosen: 'light', current: 'light' }), 'dark')
    assert.equal(toggledTheme({ chosen: 'dark', current: 'light' }), 'light')
  })

  test('reads the theme shown, not the one AO3 shows, under an explicit choice', () => {
    assert.equal(toggledTheme({ chosen: 'light', current: 'dark' }), 'dark')
    assert.equal(toggledTheme({ chosen: 'dark', current: 'dark' }), 'light')
  })

  test('from following AO3, makes the opposite of what AO3 resolved to explicit', () => {
    assert.equal(toggledTheme({ chosen: 'inherit', current: 'light' }), 'dark')
    assert.equal(toggledTheme({ chosen: 'inherit', current: 'dark' }), 'light')
  })

  test('never chooses to follow AO3', () => {
    for (const chosen of ['inherit', 'light', 'dark']) {
      for (const current of ['light', 'dark'])
        assert.notEqual(toggledTheme({ chosen, current }), 'inherit')
    }
  })
})
