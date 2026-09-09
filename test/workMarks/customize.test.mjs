import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MARK_ICON,
  FALLBACK_MARK_ICON,
  legacyMarkIcon,
  MARK_ICON_NAMES,
  markIconClassName,
  resolveMarkIcon,
} from '../../src/common/markIcons.ts'
import {
  addMark,
  createDefaultMarks,
  localMarkIds,
  markHidesResults,
  markIdFor,
  markIsExclusive,
  markIsOffered,
  markIsReorderable,
  markNameError,
  markRoot,
  READ_MARK,
  reorderableMarkIds,
  sanitizeMarkId,
} from '../../src/common/workMarks.ts'

describe('turning a name into a key', () => {
  test('lower-cases and hyphenates', () => {
    assert.equal(sanitizeMarkId('Did Not Finish'), 'did-not-finish')
    assert.equal(sanitizeMarkId('Favorite'), 'favorite')
    assert.equal(sanitizeMarkId('  Slow   burn  '), 'slow-burn')
  })

  test('folds accents away rather than dropping the letter', () => {
    assert.equal(sanitizeMarkId('Café'), 'cafe')
    assert.equal(sanitizeMarkId('naïve'), 'naive')
  })

  test('strips punctuation without leaving stray hyphens', () => {
    assert.equal(sanitizeMarkId('Re-read!'), 're-read')
    assert.equal(sanitizeMarkId('"Meh."'), 'meh')
    assert.equal(sanitizeMarkId('#1 pick'), '1-pick')
  })

  test('a name with nothing usable in it comes out empty', () => {
    assert.equal(sanitizeMarkId('Ангст'), '')
    assert.equal(sanitizeMarkId('   '), '')
  })

  test('markIdFor falls back to the first free mark-N, never to a clash', () => {
    const marks = createDefaultMarks()
    assert.equal(markIdFor(marks, 'Ангст'), 'mark-1')
    const taken = { ...marks, 'mark-1': { ...marks.read } }
    assert.equal(markIdFor(taken, 'Ангст'), 'mark-2')
  })
})

describe('adding a mark', () => {
  test('refuses a blank name and a key already taken', () => {
    const marks = createDefaultMarks()
    assert.match(markNameError(marks, '   '), /name/i)
    assert.match(markNameError(marks, 'Favorite'), /favorite/)
    assert.match(markNameError(marks, 'favorite'), /favorite/, 'the clash is on the key, not the spelling')
    assert.equal(markNameError(marks, 'Did not finish'), null)
  })

  test('a refused name leaves the table untouched', () => {
    const marks = createDefaultMarks()
    assert.equal(addMark(marks, 'Favorite'), marks)
    assert.equal(addMark(marks, ''), marks)
  })

  test('a new mark is another reading of read, hidden by default', () => {
    const marks = addMark(createDefaultMarks(), 'Did Not Finish')
    const added = marks['did-not-finish']
    assert.ok(added, 'filed under the sanitized name')
    assert.equal(added.label, 'Did Not Finish', 'the name typed is the display name')
    assert.equal(added.icon, DEFAULT_MARK_ICON)
    assert.equal(added.color, createDefaultMarks().read.color)
    assert.equal(added.items, '', 'it holds its own ids')
    assert.equal(markRoot(marks, 'did-not-finish'), READ_MARK)
    assert.ok(!markIsExclusive(marks, 'did-not-finish'), 'it stacks with the other readings')
    assert.equal(markHidesResults(marks, 'did-not-finish'), true)
  })

  test('it lands last among the verdicts, still ahead of the pinned marks', () => {
    const marks = addMark(createDefaultMarks(), 'Did Not Finish')
    assert.equal(reorderableMarkIds(marks).at(-1), 'did-not-finish')
    assert.deepEqual(localMarkIds(marks).slice(-2), ['did-not-finish', 'continue'])
    assert.ok(markIsReorderable(marks, 'did-not-finish'))
  })

  test('the order is renumbered, so no two marks claim one slot', () => {
    const marks = addMark(createDefaultMarks(), 'Did Not Finish')
    const orders = Object.values(marks).map(config => config.order)
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'ascending in table order')
    assert.equal(new Set(orders).size, orders.length, 'and each one only once')
  })

  test('the name is trimmed before it is stored', () => {
    const marks = addMark(createDefaultMarks(), '  Re-read  ')
    assert.equal(marks['re-read'].label, 'Re-read')
  })
})

describe('switching a mark off', () => {
  test('a mark is offered until it says otherwise', () => {
    const marks = createDefaultMarks()
    for (const id of localMarkIds(marks))
      assert.ok(markIsOffered(marks, id), `${id} ships offered`)
  })

  test('disabled takes it out of the menus and nothing else', () => {
    const marks = createDefaultMarks()
    marks.boring.disabled = true
    assert.ok(!markIsOffered(marks, 'boring'))
    assert.ok(markIsOffered(marks, 'bad'), 'one mark at a time')
    assert.equal(markHidesResults(marks, 'boring'), false, 'it still follows read on hiding')
    assert.ok(localMarkIds(marks).includes('boring'), 'and it is still in the table')
  })
})

describe('mark icons', () => {
  test('the shipped marks all wear a palette icon', () => {
    for (const [id, config] of Object.entries(createDefaultMarks()))
      assert.ok(MARK_ICON_NAMES.includes(config.icon), `${id}'s icon ${config.icon} is not in the palette`)
  })

  test('the defaults and the fallback are themselves in the palette', () => {
    assert.ok(MARK_ICON_NAMES.includes(DEFAULT_MARK_ICON))
    assert.ok(MARK_ICON_NAMES.includes(FALLBACK_MARK_ICON))
  })

  test('a legacy icon key still resolves to the icon it used to mean', () => {
    assert.equal(resolveMarkIcon('favorite'), 'mdi/heart')
    assert.equal(resolveMarkIcon('continue'), 'mdi/calendar-clock')
    assert.equal(legacyMarkIcon('favorite'), 'mdi/heart')
  })

  test('a name nobody knows draws the fallback but is not "legacy"', () => {
    assert.equal(resolveMarkIcon('mdi/nonesuch'), FALLBACK_MARK_ICON)
    assert.equal(resolveMarkIcon(undefined), FALLBACK_MARK_ICON)
    // What the upgrade path leans on: it may only rewrite what it recognises,
    // or it would write an unknown icon down as a bookmark for good.
    assert.equal(legacyMarkIcon('mdi/nonesuch'), undefined)
    assert.equal(legacyMarkIcon('mdi/heart'), undefined, 'a file name is not a legacy key')
  })

  test('class names are the file name with the slash swapped for a hyphen', () => {
    assert.equal(markIconClassName('mdi/book-check'), 'i-mdi-book-check')
  })

  /**
   * The content script's registry inlines one SVG per name at build time, so a
   * palette entry it doesn't list is a mark that silently draws a bookmark. Read
   * as text rather than imported: the module resolves `~icons/*`, which only
   * exists inside a build.
   */
  test('the content script has an icon for every name in the palette', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/content_script/markIcons.tsx', import.meta.url)),
      'utf8',
    )
    for (const name of MARK_ICON_NAMES)
      assert.ok(source.includes(`'${name}':`), `content_script/markIcons.tsx has no entry for ${name}`)
  })
})
