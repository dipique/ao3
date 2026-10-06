import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { skip, startOptions } from './optionsPage.mjs'

const COMPLETION = 'filter-defaults-default-completion-status'
const CROSSOVERS = 'filter-defaults-default-crossovers'

/**
 * The completion and crossover rows under Filter defaults. Switching one on
 * stores its starting choice, so the default is live the moment the row opens;
 * picking another from its dropdown stores that.
 */
describe('options UI — completion and crossover defaults', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({ hash: '#filter-defaults' })
  }, { timeout: 180000 })

  after(() => session?.close())

  const switchOn = async (row) => {
    await (await options.control(await options.row(row), 'switch')).click()
    await sleep(500)
  }

  /**
   * Open the row's dropdown and pick the option reading `label`. The dropdown is
   * brought to the middle of the window first: at the bottom, the "Options
   * saved" toasts from the switch can be sitting over it.
   */
  const choose = async (row, label) => {
    const combobox = await options.control(await options.row(row), 'combobox')
    await combobox.evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().top - window.innerHeight / 2, behavior: 'instant' }))
    await combobox.click()
    await sleep(300)
    await (await options.control(options.page, 'option', label)).click()
    await sleep(500)
  }

  const shown = async row => options.text(await options.control(await options.row(row), 'combobox'))

  test('switching on the completion default stores its starting choice', async () => {
    await switchOn(COMPLETION)
    assert.deepEqual(await options.lastWrite('option.searchCompletion'), { enabled: true, completion: 'complete' })
    assert.equal(await shown(COMPLETION), 'Completed works only')
  })

  test('picking works in progress stores it', async () => {
    await choose(COMPLETION, 'Incomplete works only')
    assert.deepEqual(await options.lastWrite('option.searchCompletion'), { enabled: true, completion: 'incomplete' })
  })

  test('switching on the crossover default stores its starting choice', async () => {
    await switchOn(CROSSOVERS)
    assert.deepEqual(await options.lastWrite('option.searchCrossovers'), { enabled: true, crossovers: 'exclude' })
    assert.equal(await shown(CROSSOVERS), 'No crossovers')
  })

  test('picking crossovers only stores it', async () => {
    await choose(CROSSOVERS, 'Crossovers only')
    assert.deepEqual(await options.lastWrite('option.searchCrossovers'), { enabled: true, crossovers: 'only' })
  })

  test('no page errors along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})
