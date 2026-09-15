// The guard on SYNC_SCHEMA_VERSION: the shape of what sync carries is recorded
// per version in sync-shape.json, and the shape the code has now must match the
// record for the version it declares. Change a synced option's shape without a
// bump, and this fails.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { SYNC_SCHEMA_VERSION } from '../../src/common/syncCodec.ts'
import { syncShape } from '../../src/common/syncShape.ts'

const history = JSON.parse(readFileSync(new URL('./sync-shape.json', import.meta.url), 'utf8'))

const BUMP = `The synced option shape changed. An older build at sync version ${SYNC_SCHEMA_VERSION} would drop or misread it, so bump SYNC_SCHEMA_VERSION (src/common/syncCodec.ts) and add the new shape to test/sync/sync-shape.json under the new number. Leave older entries alone; they're the record of what each version meant.`

describe('sync compatibility version', () => {
  test('the synced shape matches the one recorded for this version', () => {
    const recorded = history[String(SYNC_SCHEMA_VERSION)]
    assert.ok(recorded, `sync-shape.json has no entry for sync version ${SYNC_SCHEMA_VERSION}. ${BUMP}`)
    assert.deepEqual(syncShape(OPTION_DEFAULTS), recorded, BUMP)
  })

  test('the record runs without gaps up to this version', () => {
    const versions = Object.keys(history).map(Number).sort((a, b) => a - b)
    assert.equal(versions.at(-1), SYNC_SCHEMA_VERSION, 'the newest recorded shape is the current version\'s')
    versions.forEach((version, i) => {
      if (i > 0)
        assert.equal(version, versions[i - 1] + 1, `sync-shape.json skips from ${versions[i - 1]} to ${version}`)
    })
  })

  test('the shape sees what a bump is for', () => {
    // A new option, a restructured one, and a new field on a default mark all
    // change it; a new default mark and a changed default value don't.
    const base = syncShape(OPTION_DEFAULTS)
    const changed = update => syncShape({ ...structuredClone(OPTION_DEFAULTS), ...update })
    assert.notDeepEqual(changed({ brandNewOption: false }), base)
    assert.notDeepEqual(changed({ readerMode: { enabled: false } }), base)
    const withField = structuredClone(OPTION_DEFAULTS.workMarks)
    withField.marks.read.pinned = true
    assert.notDeepEqual(changed({ workMarks: withField }), base)

    const withMark = structuredClone(OPTION_DEFAULTS.workMarks)
    withMark.marks.extra = { ...withMark.marks.good, label: 'Extra' }
    assert.deepEqual(changed({ workMarks: withMark }), base)
    assert.deepEqual(changed({ wordsPerMinute: 350 }), base)
    assert.deepEqual(changed({ verbose: { anything: 'local-only' } }), base, 'local-only options aren\'t synced')
  })
})
