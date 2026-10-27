import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { backupList, NEXT_BACKUP } from '../../src/options_ui/model/backups.ts'
import { numbers } from '../facts.mjs'
import { mentions, scriptBackground, skip, startOptions, until } from './optionsPage.mjs'
import { toastTypes } from './trackedPages.mjs'

const WIDE = { width: 1440, height: 900 }
const NARROW = { width: 390, height: 844 }

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

/** A backup's summary, as `api.listBackups` answers with it, taken `ago` milliseconds before the page opens. */
function backup(kind, ago, label = '') {
  const createdAt = Date.now() - ago
  return { key: `backup.${createdAt}`, createdAt, date: '', kind, label }
}

/** One of each kind, and two daily ones, in no order. */
function everyKind() {
  return [
    backup('pre-sync', 4 * DAY),
    backup('daily', 6 * DAY),
    backup('sync-held', 2 * DAY),
    backup('daily', MINUTE),
    backup('sync-declined', 5 * DAY),
    backup('pre-restore', 3 * DAY, 'Before restore'),
  ]
}

const newestFirst = backups => [...backups].sort((a, b) => b.createdAt - a.createdAt)

/** What the list says of `backups`, as the page words it, with daily backups as the page opens with them. */
const listOf = (backups, daily = { enabled: true, count: 7 }) => backupList(backups, daily, Date.now())

/**
 * Sync & Backups → Backups: the switch, the count to keep while it is on, and
 * the snapshots as a list in place, newest first, each restored from its own
 * row. Restoring replaces every setting, so its button asks a second time in
 * its place. What the list says of each backup is the backup list's unit
 * tests; this is what the page draws from the background's answer, and what
 * it sends.
 */
describe('options UI — backups', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  /** The options page at Backups, its background answering from `replies`. */
  const open = (replies, seed = {}, viewport = WIDE) => session.open({
    seed: { 'sync.backupsEnabled': true, 'sync.backupCount': 7, ...seed },
    hash: '#backups',
    viewport,
    prepare: page => page.evaluateOnNewDocument(scriptBackground, replies),
  })

  /** The Restore button of the backup `key`. */
  const restoreButton = async (options, key) => options.action(await options.listRow('backups', key), 'restore')
  /** Whether a first press has armed the button, to restore on the next. */
  const armed = button => button.evaluate(el => el.dataset.armed !== undefined)
  /** What a row says of its backup: what took it, how long it is kept, and when. */
  const rowParts = row => row.evaluate(el => Object.fromEntries([...el.querySelectorAll('[data-backup-part]')]
    .map(part => [part.dataset.backupPart, part.textContent.replace(/\s+/g, ' ').trim()])))

  test('lists the snapshots the background has, newest first: what took each, how long it is kept, and when', async () => {
    const backups = everyKind()
    const options = await open({ listBackups: backups })
    try {
      assert.ok((await options.sent('listBackups')).length > 0, 'asked the background')
      const sorted = newestFirst(backups)
      assert.deepEqual(await options.listRowIds('backups'), sorted.map(b => b.key))
      assert.deepEqual(numbers(await options.listCount('backups')), [6])

      const view = listOf(backups)
      const rows = await options.listRows('backups')
      assert.deepEqual(await Promise.all(rows.map(rowParts)), view.rows.map(({ label, retention, when }) => ({ label, retention, when })))
      for (const [i, row] of rows.entries())
        assert.equal(await options.name(await options.action(row, 'restore')), view.rows[i].restore, 'every row restores, naming the backup')
    }
    finally {
      await options.close()
    }
  })

  test('with none yet, says so and when one is taken', async () => {
    const options = await open({ listBackups: [] })
    try {
      assert.deepEqual(await options.listRowIds('backups'), [])
      assert.equal(await options.listCount('backups'), listOf([]).count)
      const empty = await options.text(await options.page.$('[data-list="backups"] [data-list-empty]'))
      assert.ok(mentions(empty, listOf([]).empty.title))
      assert.ok(mentions(empty, NEXT_BACKUP.daily))
    }
    finally {
      await options.close()
    }
  })

  test('Restore asks again in its place, one row at a time, then sends restoreBackup and says so', async () => {
    const backups = newestFirst(everyKind())
    const [first, second] = backups
    const options = await open({ listBackups: backups, restoreBackup: true })
    try {
      await options.press(await restoreButton(options, first.key))
      assert.equal(await armed(await restoreButton(options, first.key)), true)

      await options.press(await restoreButton(options, second.key))
      assert.equal(await armed(await restoreButton(options, second.key)), true)
      assert.equal(await armed(await restoreButton(options, first.key)), false, 'arming one disarms the other')
      assert.deepEqual(await options.sent('restoreBackup'), [], 'nothing is restored on a first press')

      const asked = (await options.sent('listBackups')).length
      await options.press(await restoreButton(options, second.key))
      await until('the restore to be said', async () => (await toastTypes(options.page)).includes('success'))
      assert.deepEqual(await options.sent('restoreBackup'), [[second.key]])
      await until('the list to be read again, with the backup the restore took', async () => (await options.sent('listBackups')).length > asked)
      assert.equal(await armed(await restoreButton(options, second.key)), false)
    }
    finally {
      await options.close()
    }
  })

  test('while a restore runs, its button says so and can\'t be pressed', async () => {
    const backups = [backup('daily', MINUTE)]
    const options = await open({ listBackups: backups, restoreBackup: 'never' })
    try {
      const button = await restoreButton(options, backups[0].key)
      await options.press(button)
      await options.press(button)
      await until('the button to say the restore is running', async () => button.evaluate(el => el.dataset.restoring !== undefined))
      assert.equal(await button.evaluate(el => el.disabled), true)
      assert.equal(await armed(button), false)
    }
    finally {
      await options.close()
    }
  })

  test('a restore that fails says so', async () => {
    const backups = [backup('daily', MINUTE)]
    const options = await open({ listBackups: backups, restoreBackup: 'fail' })
    try {
      const button = await restoreButton(options, backups[0].key)
      await options.press(button)
      await options.press(button)
      await until('the failure to be said', async () => (await toastTypes(options.page)).includes('error'))
      assert.equal(await armed(button), false)
      assert.equal(await button.evaluate(el => el.disabled || el.dataset.restoring !== undefined), false, 'ready to be pressed again')
    }
    finally {
      await options.close()
    }
  })

  test('a backup taken while the page is open joins the list', async () => {
    const older = [backup('daily', DAY)]
    const options = await open({ listBackups: older })
    try {
      assert.deepEqual(await options.listRowIds('backups'), [older[0].key])
      const taken = [backup('daily', 0), ...older]
      await options.page.evaluate(async (backups) => {
        window.__replies.listBackups = backups
        await window.browser.storage.local.set({ 'sync.backups': backups })
      }, taken)
      await until('the new backup to join the list', async () => (await options.listRowIds('backups')).length === taken.length)
      assert.deepEqual(await options.listRowIds('backups'), taken.map(b => b.key))
    }
    finally {
      await options.close()
    }
  })

  test('the count to keep shows while daily backups are on', async () => {
    const options = await open({ listBackups: [] })
    try {
      const count = '[id="backups-number-of-daily-backups-to-keep"]'
      assert.ok(await options.page.$(count), 'shown while on')

      await options.press(await options.control(await options.row('backups-keep-daily-backups'), 'switch'))
      await until('daily backups to be turned off', async () => await options.stored('sync.backupsEnabled') === false)
      assert.equal(await options.page.$(count), null, 'gone while off')
      const empty = await options.text(await options.page.$('[data-list="backups"] [data-list-empty]'))
      assert.ok(mentions(empty, NEXT_BACKUP.off))
    }
    finally {
      await options.close()
    }
  })

  test('the count to keep is a stepper, and each press writes it', async () => {
    const options = await open({ listBackups: [] })
    try {
      const row = await options.row('backups-number-of-daily-backups-to-keep')
      assert.equal(await (await options.control(row, 'spinbutton')).evaluate(el => el.value), '7')
      // The stepper steps as the pointer goes down, so it is pressed with the pointer.
      await (await options.action(row, 'increment')).click()
      await until('the count to be written', async () => await options.stored('sync.backupCount') === 8)
      await (await options.action(row, 'decrement')).click()
      await until('the count to be written again', async () => await options.stored('sync.backupCount') === 7)
    }
    finally {
      await options.close()
    }
  })

  test('the snapshots sit in an inset that pads them by 10 px, and on a phone in none', async () => {
    for (const viewport of [WIDE, NARROW]) {
      const options = await open({ listBackups: everyKind() }, {}, viewport)
      try {
        const inset = await (await options.list('backups')).evaluate((frame) => {
          const panel = frame.closest('[data-row-inset]')
          return panel && getComputedStyle(panel).padding
        })
        assert.equal(inset, viewport === WIDE ? '10px' : null, `at ${viewport.width} px`)
      }
      finally {
        await options.close()
      }
    }
  })

  test('on a phone, each row puts its date under its name, and nothing overflows', async () => {
    const backups = everyKind()
    const options = await open({ listBackups: backups }, {}, NARROW)
    try {
      const [row] = await options.listRows('backups')
      const lines = await options.lines(row)
      const [newest] = listOf(backups).rows
      const restore = await options.text(await options.action(row, 'restore'))
      assert.deepEqual(lines, [newest.label, newest.when, restore], 'its name, then its date, then Restore, each a line of its own')

      const { scrollWidth, innerWidth } = await options.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
      assert.ok(scrollWidth <= innerWidth, `the page is ${scrollWidth} px wide in a ${innerWidth} px window`)
      const frame = await (await options.list('backups')).evaluate(el => el.getBoundingClientRect().right)
      const button = await (await restoreButton(options, newestFirst(backups)[0].key)).evaluate(el => el.getBoundingClientRect().right)
      assert.ok(button <= frame, `Restore ends at ${button} px, past the list's ${frame} px`)
    }
    finally {
      await options.close()
    }
  })
})
