import { isDeepEqual } from '@antfu/utils'

import type { Manifest, Options } from '#common'

import {
  buildLocalUpdate,
  canonicalStringify,
  createLogger,
  decidePull,
  decidePush,
  decode,
  diffChunks,
  encode,
  hash,
  MANIFEST_KEY,
  options,
  pruneToSynced,
  QUOTA_BYTES,
  SYNC_SCHEMA_VERSION,
  syncMeta,
} from '#common'

import { createBackup, maybeDailyBackup } from './backups.ts'

const logger = createLogger('Sync')

/**
 * Replication engine: keeps the canonical `option.*` working copy in
 * `storage.local` in sync with a compressed, chunked mirror in `storage.sync`.
 * This module is the I/O shell; all conflict logic is in the pure `syncDecide`
 * functions. Lives only in the background context (the single writer).
 *
 * Listeners are registered synchronously at the top of `background.ts` so an MV3
 * wake-up event is never dropped; everything here is invoked from those.
 */

const ALARM_PUSH = 'ao3e-sync-push'
const ALARM_PULL_RETRY = 'ao3e-sync-pull-retry'
/** Generous debounce so we stay far under sync write-rate limits (≤1 push/min). */
const DEBOUNCE_MIN = 1
/** Hard ceiling: a continuous edit stream still flushes within this window. */
const MAX_WAIT_MS = 5 * 60_000
const PULL_RETRY_MIN = 0.25
const MAX_PULL_RETRIES = 3

const isChunkKey = (k: string) => /^o\d+$/.test(k)

/** Bounded, in-memory retry counter for half-propagated reads (resets on SW restart — fine). */
let pullRetries = 0

// Serialize every mutating operation so concurrent storage/alarm events can't
// interleave a read-modify-write. This also makes the push's own sync-write echo
// harmless: the echoed pull queues behind the push and sees the updated meta.
let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

// ---------------------------------------------------------------------------
// Public surface (wired into background.ts listeners + API)
// ---------------------------------------------------------------------------

/** Synchronous storage.onChanged handler — must stay sync so MV3 never misses a wake event. */
export function onStorageChanged(changes: Record<string, unknown>, areaName: string): void {
  if (areaName === 'local') {
    if (Object.keys(changes).some(k => k.startsWith('option.')))
      void withLock(handleLocalChange)
  }
  else if (areaName === 'sync') {
    if (Object.keys(changes).some(k => k === MANIFEST_KEY || isChunkKey(k)))
      void withLock(pull)
  }
}

export function onAlarm(alarm: { name: string }): void {
  if (alarm.name === ALARM_PUSH)
    void withLock(push)
  else if (alarm.name === ALARM_PULL_RETRY)
    void withLock(pull)
}

/** Startup reconciliation: adopt anything newer, resume a pending push. */
export async function initSyncEngine(): Promise<void> {
  if (!(await syncMeta.get('enabled')))
    return
  await withLock(async () => {
    await getDeviceId()
    await pull()
    if (await syncMeta.get('dirty'))
      await scheduleAlarm()
  })
}

export async function setSyncEnabled(enabled: boolean): Promise<void> {
  await syncMeta.set({ enabled })
  await withLock(enabled ? enable : disable)
}

/** Explicit "forget the cloud copy" action — removes this extension's sync keys. */
export async function clearSyncedData(): Promise<void> {
  await withLock(async () => {
    const items = await browser.storage.sync.get(null)
    const keys = Object.keys(items).filter(k => k === MANIFEST_KEY || isChunkKey(k))
    if (keys.length)
      await browser.storage.sync.remove(keys)
    await syncMeta.set({ meta: { g: 0, h: '', w: '' }, dirty: false, dirtySince: 0, lastError: '', lastSyncAt: 0 })
  })
}

export async function getSyncUsage(): Promise<{ used: number, quota: number, overheadBytes: number }> {
  let used = 0
  try {
    used = await browser.storage.sync.getBytesInUse(null)
  }
  catch { /* getBytesInUse can throw if sync is unavailable */ }
  const manifest = await readManifest()
  // "Fixed overhead of our format" = the manifest item (key + JSON value + quotes).
  const overheadBytes = manifest ? MANIFEST_KEY.length + JSON.stringify(manifest).length + 2 : 0
  return { used, quota: QUOTA_BYTES, overheadBytes }
}

export async function getSyncStatus(): Promise<{
  enabled: boolean
  lastError: string
  lastSyncAt: number
  generation: number
  dirty: boolean
}> {
  const m = await syncMeta.get(['enabled', 'lastError', 'lastSyncAt', 'meta', 'dirty'])
  return {
    enabled: m.enabled,
    lastError: m.lastError,
    lastSyncAt: m.lastSyncAt,
    generation: m.meta.g,
    dirty: m.dirty,
  }
}

// ---------------------------------------------------------------------------
// Core operations (always run inside withLock)
// ---------------------------------------------------------------------------

async function handleLocalChange(): Promise<void> {
  // Backups are independent of sync — keep a daily restore point regardless.
  await maybeDailyBackup()

  if (!(await syncMeta.get('enabled')))
    return

  // Real dirtiness is "does the pruned local state differ from what's synced?".
  // This naturally absorbs our own pull-writes (which leave localHash === meta.h)
  // and per-device churn like theme.current, so no echo-suppression flag is needed.
  const localHash = await currentHash()
  const meta = await syncMeta.get('meta')
  if (localHash === meta.h)
    return

  const { dirty } = await syncMeta.get(['dirty'])
  await syncMeta.set(dirty ? { dirty: true } : { dirty: true, dirtySince: Date.now() })
  await scheduleAlarm()
}

async function push(): Promise<void> {
  if (!(await syncMeta.get('enabled')))
    return

  const meta = await syncMeta.get('meta')
  const opts = await options.get()
  const pruned = pruneToSynced(opts, options.defaults)
  const localHash = hash(canonicalStringify(pruned))
  const remote = await readManifest()

  const decision = decidePush(meta, remote, localHash)
  logger.log('push decision', decision)
  if (decision === 'noop') {
    if (localHash === meta.h)
      await syncMeta.set({ dirty: false, dirtySince: 0 })
    return
  }
  if (decision === 'pull') {
    await pull()
    return
  }

  const token = `${await getDeviceId()}.${crypto.randomUUID().slice(0, 8)}`
  const newGen = Math.max(meta.g, remote?.g ?? 0) + 1
  const { chunks, manifest } = await encode(opts, options.defaults, newGen, token)

  const currentItems = await browser.storage.sync.get(null)
  const { toSet, toRemove } = diffChunks(pickChunks(currentItems), chunks)

  try {
    await browser.storage.sync.set({ ...toSet, [MANIFEST_KEY]: manifest })
    if (toRemove.length)
      await browser.storage.sync.remove(toRemove)
  }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('push failed', msg)
    // Don't advance meta and keep `dirty` set so a later change retries.
    await syncMeta.set({ lastError: quotaHint(msg) })
    return
  }

  // Compare-after-write: confirm our write survived a possible same-gen race.
  const after = await readManifest()
  if (after && after.w === token) {
    await syncMeta.set({
      meta: { g: newGen, h: localHash, w: token },
      dirty: false,
      dirtySince: 0,
      lastError: '',
      lastSyncAt: Date.now(),
    })
    logger.log('push ok, gen', newGen)
  }
  else {
    logger.warn('push lost a race; pulling the winner')
    await pull()
  }
}

async function pull(): Promise<void> {
  if (!(await syncMeta.get('enabled')))
    return

  const meta = await syncMeta.get('meta')
  const items = await browser.storage.sync.get(null)
  const remote = (items[MANIFEST_KEY] as Manifest | undefined) ?? null
  if (decidePull(meta, remote) === 'noop')
    return

  const result = await decode(items)
  if (!result.ok) {
    if (result.reason === 'version') {
      await syncMeta.set({ lastError: 'Synced data uses a newer format; update the extension to sync.' })
      return
    }
    if (result.reason === 'empty')
      return
    // incomplete / corrupt: usually a half-propagated chunk set — retry briefly.
    if (pullRetries < MAX_PULL_RETRIES) {
      pullRetries++
      await browser.alarms.create(ALARM_PULL_RETRY, { delayInMinutes: PULL_RETRY_MIN })
      logger.log('pull incomplete, retry', pullRetries)
    }
    else {
      pullRetries = 0
      await syncMeta.set({ lastError: 'Could not read synced data (incomplete).' })
    }
    return
  }
  pullRetries = 0

  // Back up the pre-pull state, then apply only the keys that actually change.
  await maybeDailyBackup()
  const current = await options.get()
  const desired = buildLocalUpdate(result.options, options.defaults, current)
  const update = diffOptions(current, desired)
  if (Object.keys(update).length)
    await options.set(update)

  await syncMeta.set({
    meta: { g: remote!.g, h: remote!.h, w: remote!.w },
    dirty: false,
    dirtySince: 0,
    lastError: '',
    lastSyncAt: Date.now(),
  })
  logger.log('pull ok, gen', remote!.g)
}

async function enable(): Promise<void> {
  await getDeviceId()
  // Forget any prior agreement so the cloud copy is treated as authoritative.
  await syncMeta.set({ meta: { g: 0, h: '', w: '' }, lastError: '' })

  const remote = await readManifest()
  if (remote && remote.v > SYNC_SCHEMA_VERSION) {
    await syncMeta.set({ lastError: 'Synced data uses a newer format; update the extension to sync.' })
    return
  }
  if (remote) {
    // Adopt synced settings; back up local first (deliberate destructive adopt).
    if (await syncMeta.get('backupsEnabled'))
      await createBackup('pre-sync')
    await pull()
  }
  else {
    await push() // seed the cloud from this device
  }
}

async function disable(): Promise<void> {
  await browser.alarms.clear(ALARM_PUSH)
  await browser.alarms.clear(ALARM_PULL_RETRY)
  await syncMeta.set({ dirty: false, dirtySince: 0 })
  // Cloud data is intentionally left intact — clearing would wipe other devices.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function currentHash(): Promise<string> {
  const opts = await options.get()
  return hash(canonicalStringify(pruneToSynced(opts, options.defaults)))
}

async function readManifest(): Promise<Manifest | null> {
  const got = await browser.storage.sync.get(MANIFEST_KEY)
  return (got[MANIFEST_KEY] as Manifest | undefined) ?? null
}

function pickChunks(items: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(items)) {
    if (isChunkKey(k) && typeof v === 'string')
      out[k] = v
  }
  return out
}

function diffOptions(current: Options, desired: Options): Partial<Options> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(desired) as (keyof Options)[]) {
    if (!isDeepEqual(current[key], desired[key]))
      out[key] = desired[key]
  }
  return out as Partial<Options>
}

async function scheduleAlarm(): Promise<void> {
  const existing = await browser.alarms.get(ALARM_PUSH)
  if (existing) {
    // Don't keep deferring forever — once past the ceiling, let the pending alarm fire.
    const dirtySince = await syncMeta.get('dirtySince')
    if (Date.now() - dirtySince > MAX_WAIT_MS)
      return
  }
  await browser.alarms.create(ALARM_PUSH, { delayInMinutes: DEBOUNCE_MIN })
}

async function getDeviceId(): Promise<string> {
  let id = await syncMeta.get('deviceId')
  if (!id) {
    id = crypto.randomUUID().slice(0, 8)
    await syncMeta.set({ deviceId: id })
  }
  return id
}

function quotaHint(msg: string): string {
  return /quota/i.test(msg)
    ? 'Settings are too large to sync — reduce filter lists or text replacements.'
    : `Sync failed: ${msg}`
}
