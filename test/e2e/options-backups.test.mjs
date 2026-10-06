import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { scriptBackground, skip, startOptions } from './optionsPage.mjs'

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

const KEPT_APART = 'kept apart · newest five of its kind'

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
  const restoreButton = async (options, key) => options.control(await options.listRow('backups', key), 'button')

  test('lists the snapshots the background has, newest first: what took each, how long it is kept, and when', async () => {
    const backups = everyKind()
    const options = await open({ listBackups: backups })
    try {
      assert.ok((await options.sent('listBackups')).length > 0, 'asked the background')
      const sorted = newestFirst(backups)
      assert.deepEqual(await options.listRowIds('backups'), sorted.map(b => b.key))
      assert.equal(await options.listCount('backups'), '6 · newest first')

      const rows = await options.listRows('backups')
      const read = await Promise.all(rows.map(row => options.lines(row)))
      assert.deepEqual(read.map(lines => lines.slice(0, 2)), [
        ['Daily backup', 'daily · the newest 7 are kept'],
        ['Before a held sync update', KEPT_APART],
        ['Before a restore', KEPT_APART],
        ['Before turning on sync', KEPT_APART],
        ['Sync update you declined', KEPT_APART],
        ['Daily backup', 'daily · the newest 7 are kept'],
      ])
      assert.match(read[0][2], /^Today, \S/)
      assert.ok(read.every(lines => lines.at(-1) === 'Restore'), 'every row restores')

      const name = await options.name(await restoreButton(options, sorted[0].key))
      assert.equal(name, `Restore “Daily backup” from ${read[0][2]}`)
    }
    finally {
      await options.close()
    }
  })

  test('with none yet, says so and when one is taken', async () => {
    const options = await open({ listBackups: [] })
    try {
      assert.deepEqual(await options.listRowIds('backups'), [])
      assert.equal(await options.listCount('backups'), 'none yet')
      assert.ok((await options.lines(await options.list('backups'))).includes('No backups yet'))
      assert.match(await options.text(await options.list('backups')), /One is saved automatically the first time you change a setting each day\.$/)
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
      assert.equal(await options.text(await restoreButton(options, first.key)), 'Restore?')

      await options.press(await restoreButton(options, second.key))
      assert.equal(await options.text(await restoreButton(options, second.key)), 'Restore?')
      assert.equal(await options.text(await restoreButton(options, first.key)), 'Restore', 'arming one disarms the other')
      assert.deepEqual(await options.sent('restoreBackup'), [], 'nothing is restored on a first press')

      const asked = (await options.sent('listBackups')).length
      await options.press(await restoreButton(options, second.key))
      await sleep(300)
      assert.deepEqual(await options.sent('restoreBackup'), [[second.key]])
      assert.ok((await options.toasts()).includes('Backup restored'))
      assert.ok((await options.sent('listBackups')).length > asked, 'the list is read again, with the backup the restore took')
      assert.equal(await options.text(await restoreButton(options, second.key)), 'Restore')
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
      await sleep(200)
      assert.equal(await options.text(button), 'Restoring…')
      assert.equal(await button.evaluate(el => el.disabled), true)
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
      await sleep(300)
      assert.ok((await options.toasts()).includes('Failed to restore backup; see console for details'))
      assert.equal(await options.text(button), 'Restore')
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
      await sleep(300)
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
      await sleep(300)
      assert.equal(await options.stored('sync.backupsEnabled'), false)
      assert.equal(await options.page.$(count), null, 'gone while off')
      assert.match(await options.text(await options.list('backups')), /No backups yet\s*Daily backups are off\.$/)
    }
    finally {
      await options.close()
    }
  })

  test('on a phone, each row puts its date under its name, and nothing overflows', async () => {
    const backups = everyKind()
    const options = await open({ listBackups: backups }, {}, NARROW)
    try {
      const [row] = await options.listRows('backups')
      const lines = await options.lines(row)
      assert.equal(lines.length, 3, `read ${JSON.stringify(lines)}`)
      assert.equal(lines[0], 'Daily backup')
      assert.match(lines[1], /^Today, \S/)
      assert.equal(lines[2], 'Restore')

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
