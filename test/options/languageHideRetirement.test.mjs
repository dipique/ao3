import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { planLanguageHideRetirement } from '../../src/common/searchLanguage.ts'

const ENGLISH = { label: 'English', value: 'en' }
const FRENCH = { label: 'Français', value: 'fr' }

/** Apply a plan to a stored-options record the way the migration does. */
function apply(stored, plan) {
  if (!plan)
    return stored
  const next = { ...stored }
  delete next.hideLanguages
  if (plan.searchLanguage)
    next.searchLanguage = plan.searchLanguage
  return next
}

describe('retiring the hide-by-language setting', () => {
  test('one language hidden around becomes the default language filter', () => {
    const plan = planLanguageHideRetirement({ hideLanguages: { enabled: true, show: [ENGLISH] } })
    assert.deepEqual(plan, { searchLanguage: { enabled: true, language: ENGLISH } })
  })

  test('carries over whether or not it already set the filter', () => {
    for (const applyToSearch of [true, false, undefined]) {
      const plan = planLanguageHideRetirement({ hideLanguages: { enabled: true, show: [ENGLISH], applyToSearch } })
      assert.deepEqual(plan, { searchLanguage: { enabled: true, language: ENGLISH } }, `applyToSearch: ${applyToSearch}`)
    }
  })

  test('a default language already on is left alone', () => {
    const plan = planLanguageHideRetirement({
      hideLanguages: { enabled: true, show: [ENGLISH] },
      searchLanguage: { enabled: true, language: FRENCH },
    })
    assert.deepEqual(plan, {})
  })

  test('a default language switched off, or on with none chosen, takes the hidden one', () => {
    for (const searchLanguage of [{ enabled: false, language: FRENCH }, { enabled: true, language: null }]) {
      const plan = planLanguageHideRetirement({ hideLanguages: { enabled: true, show: [ENGLISH] }, searchLanguage })
      assert.deepEqual(plan, { searchLanguage: { enabled: true, language: ENGLISH } })
    }
  })

  test('nothing carries over from a setting that was off', () => {
    assert.deepEqual(planLanguageHideRetirement({ hideLanguages: { enabled: false, show: [ENGLISH] } }), {})
  })

  test('nothing carries over from several languages, or none, since the filter takes one', () => {
    for (const show of [[ENGLISH, FRENCH], [], undefined])
      assert.deepEqual(planLanguageHideRetirement({ hideLanguages: { enabled: true, show } }), {})
  })

  test('nothing carries over from a language with no code to select', () => {
    assert.deepEqual(planLanguageHideRetirement({ hideLanguages: { enabled: true, show: [{ label: 'English' }] } }), {})
  })

  test('a language carried over is a copy holding only its label and code', () => {
    const show = [{ ...ENGLISH, extra: 1 }]
    const plan = planLanguageHideRetirement({ hideLanguages: { enabled: true, show } })
    assert.deepEqual(plan.searchLanguage.language, ENGLISH)
    assert.notEqual(plan.searchLanguage.language, show[0])
  })

  test('there is nothing to do once the setting is gone', () => {
    assert.equal(planLanguageHideRetirement({}), null)
    assert.equal(planLanguageHideRetirement({ searchLanguage: { enabled: true, language: ENGLISH } }), null)
  })

  test('a malformed stored value is removed without carrying anything over', () => {
    for (const hideLanguages of [true, 'en', null, { show: 'English' }])
      assert.deepEqual(planLanguageHideRetirement({ hideLanguages }), {}, JSON.stringify(hideLanguages))
  })

  test('running it again over its own result does nothing', () => {
    const stored = { hideLanguages: { enabled: true, show: [ENGLISH], applyToSearch: true }, searchLanguage: { enabled: false, language: null } }
    const once = apply(stored, planLanguageHideRetirement(stored))
    assert.deepEqual(once, { searchLanguage: { enabled: true, language: ENGLISH } })
    assert.equal(planLanguageHideRetirement(once), null)
  })
})
