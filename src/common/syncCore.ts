import { isDeepEqual } from '@antfu/utils'

import type { BackupKind, SetSyncResult } from './api.ts'
import type { Options } from './options.ts'
import type { Manifest } from './syncCodec.ts'
import type { SyncMeta, SyncPause } from './syncMeta.ts'

import { buildLocalUpdate, canonicalStringify, decode, diffChunks, encode, hash, MANIFEST_KEY, pruneToSynced, QUOTA_BYTES, SYNC_SCHEMA_VERSION } from './syncCodec.ts'
import { decidePull, decidePush } from './syncDecide.ts'
import { assessPull } from './syncGuard.ts'

/**
 * Replication engine: keeps the canonical `option.*` working copy in
 * `storage.local` in sync with a compressed, chunked mirror in `storage.sync`.
 * All conflict logic is in the pure `syncDecide` functions; this is the I/O
 * around them, and it runs only in the background context (the single writer).
 *
 * **Everything it touches arrives as a dependency.** The background wires in the
 * real `browser.storage` areas, alarms and backups
 * ({@link file://./../background/syncEngine.ts}); the sync tests wire in fakes —
 * several engines, one per simulated browser, over one simulated sync server.
 * A sync bug is an interleaving across devices, and that's the only place one
 * can be replayed. So this module imports nothing that reaches for `browser`.
 */

export const ALARM_PUSH = 'ao3e-sync-push'
export const ALARM_PULL_RETRY = 'ao3e-sync-pull-retry'
/** Generous debounce so we stay far under sync write-rate limits (≤1 push/min). */
const DEBOUNCE_MIN = 1
/** Hard ceiling: a continuous edit stream still flushes within this window. */
const MAX_WAIT_MS = 5 * 60_000
const PULL_RETRY_MIN = 0.25
const MAX_PULL_RETRIES = 3

const isChunkKey = (k: string) => /^o\d+$/.test(k)

/** The subset of a `storage.sync` area the engine uses. */
export interface SyncStorageArea {
  get: (keys: string | string[] | null) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: string | string[]) => Promise<void>
  getBytesInUse?: (keys: null) => Promise<number>
}

/** The subset of `browser.alarms` the engine uses. */
export interface SyncAlarms {
  create: (name: string, info: { delayInMinutes: number }) => unknown
  get: (name: string) => Promise<unknown>
  clear: (name: string) => Promise<unknown>
}

export interface SyncLogger {
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface SyncDeps {
  /** Every option's default (what pruning compares against). */
  defaults: Options
  readOptions: () => Promise<Options>
  writeOptions: (update: Partial<Options>) => Promise<void>
  meta: {
    get: <K extends keyof SyncMeta>(keys: K[]) => Promise<Pick<SyncMeta, K>>
    set: (update: Partial<SyncMeta>) => Promise<void>
  }
  sync: SyncStorageArea
  alarms: SyncAlarms
  backups: {
    /** Snapshot the current options if today has no backup yet. */
    maybeDaily: () => Promise<void>
    /** Snapshot `snapshot`, or the current options when it's absent. */
    create: (kind: BackupKind, snapshot?: Partial<Options>) => Promise<void>
  }
  /** The sync version this build speaks. Defaults to {@link SYNC_SCHEMA_VERSION}. */
  version?: number
  now?: () => number
  randomId?: () => string
  logger?: SyncLogger
}

export interface SyncUsageReport { used: number, quota: number, overheadBytes: number }

export interface SyncStatusReport {
  enabled: boolean
  lastError: string
  lastSyncAt: number
  generation: number
  dirty: boolean
}

const SILENT: SyncLogger = { log() {}, warn() {}, error() {} }

export function createSyncEngine(deps: SyncDeps) {
  const { defaults, meta, sync, alarms, backups } = deps
  const now = deps.now ?? Date.now
  const randomId = deps.randomId ?? (() => crypto.randomUUID().slice(0, 8))
  const logger = deps.logger ?? SILENT
  /** Read each time: the tests swap the version a simulated browser speaks when it "updates". */
  const version = () => deps.version ?? SYNC_SCHEMA_VERSION

  /** Bounded, in-memory retry counter for half-propagated reads (resets on restart — fine). */
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

  // -------------------------------------------------------------------------
  // Public surface (wired into background.ts listeners + API)
  // -------------------------------------------------------------------------

  /** Synchronous storage.onChanged handler — must stay sync so MV3 never misses a wake event. */
  function onStorageChanged(changes: Record<string, unknown>, areaName: string): void {
    if (areaName === 'local') {
      if (Object.keys(changes).some(k => k.startsWith('option.')))
        void withLock(handleLocalChange)
    }
    else if (areaName === 'sync') {
      if (Object.keys(changes).some(k => k === MANIFEST_KEY || isChunkKey(k)))
        void withLock(() => pull())
    }
  }

  function onAlarm(alarm: { name: string }): void {
    if (alarm.name === ALARM_PUSH)
      void withLock(() => push())
    else if (alarm.name === ALARM_PULL_RETRY)
      void withLock(() => pull())
  }

  /**
   * Run every time the worker starts, whatever woke it: re-arm a push that was
   * pending when the last one stopped. Alarms don't reliably survive an
   * extension reload (which an import does straight after writing options), and
   * nothing else notices a browser still marked dirty.
   */
  async function start(): Promise<void> {
    await withLock(async () => {
      const { enabled, dirty } = await meta.get(['enabled', 'dirty'])
      if (enabled && dirty && !(await alarms.get(ALARM_PUSH)))
        await scheduleAlarm()
    })
  }

  /** Startup reconciliation: adopt anything newer, resume a pending push. */
  async function init(): Promise<void> {
    if (!(await meta.get(['enabled'])).enabled)
      return
    await withLock(async () => {
      await getDeviceId()
      await pull()
      if ((await meta.get(['dirty'])).dirty)
        await scheduleAlarm()
    })
  }

  async function setEnabled(enabled: boolean): Promise<SetSyncResult> {
    await meta.set({ enabled })
    return withLock(enabled ? enable : disable)
  }

  /** Explicit "forget the cloud copy" action — removes this extension's sync keys. */
  async function clearSyncedData(): Promise<void> {
    await withLock(async () => {
      const items = await sync.get(null)
      const keys = Object.keys(items).filter(k => k === MANIFEST_KEY || isChunkKey(k))
      if (keys.length)
        await sync.remove(keys)
      await meta.set({ meta: { g: 0, h: '', w: '' }, dirty: false, dirtySince: 0, lastError: '', lastSyncAt: 0 })
    })
  }

  /**
   * The reader's answer to a held update. `accept` applies it — this browser's
   * settings were backed up when it was held. `keep` saves the incoming copy as
   * a backup, so whatever the other browser had is still restorable, and pushes
   * this browser's settings over it.
   */
  async function resolveHeld(choice: 'accept' | 'keep'): Promise<boolean> {
    return withLock(async () => {
      const { pause } = await meta.get(['pause'])
      if (pause?.reason !== 'held')
        return false

      if (choice === 'accept') {
        await pull({ acceptLoss: true })
      }
      else {
        const items = await sync.get(null)
        const result = await decode(items)
        if (result.ok) {
          const remote = items[MANIFEST_KEY] as Manifest
          const incoming = buildLocalUpdate(result.options, defaults, await deps.readOptions(), remote.k)
          await backups.create('sync-declined', incoming)
        }
        await meta.set({ pause: null })
        await push({ force: true })
      }

      // Answered either way, even if the cloud couldn't be read just now: the
      // next update will be assessed afresh.
      if ((await meta.get(['pause'])).pause?.reason === 'held')
        await meta.set({ pause: null })
      return true
    })
  }

  async function getUsage(): Promise<SyncUsageReport> {
    let used = 0
    try {
      used = await sync.getBytesInUse?.(null) ?? 0
    }
    catch { /* getBytesInUse can throw if sync is unavailable */ }
    const manifest = await readManifest()
    // "Fixed overhead of our format" = the manifest item (key + JSON value + quotes).
    const overheadBytes = manifest ? MANIFEST_KEY.length + JSON.stringify(manifest).length + 2 : 0
    return { used, quota: QUOTA_BYTES, overheadBytes }
  }

  async function getStatus(): Promise<SyncStatusReport> {
    const m = await meta.get(['enabled', 'lastError', 'lastSyncAt', 'meta', 'dirty'])
    return {
      enabled: m.enabled,
      lastError: m.lastError,
      lastSyncAt: m.lastSyncAt,
      generation: m.meta.g,
      dirty: m.dirty,
    }
  }

  /** Resolves once every queued operation has finished (for tests and shutdown). */
  async function idle(): Promise<void> {
    let seen: Promise<unknown>
    do {
      seen = chain
      await seen
    } while (seen !== chain)
  }

  // -------------------------------------------------------------------------
  // Core operations (always run inside withLock)
  // -------------------------------------------------------------------------

  async function handleLocalChange(): Promise<void> {
    // Backups are independent of sync — keep a daily restore point regardless.
    await backups.maybeDaily()

    const { enabled, pause } = await meta.get(['enabled', 'pause'])
    if (!enabled)
      return
    // Paused for a newer cloud copy: what's edited on this build won't be
    // pushed once it's updated either — the update pulls the newer copy first.
    if (pause?.reason === 'newer-version')
      return

    // Real dirtiness is "does the pruned local state differ from what we last
    // agreed on?". A pull records the hash of what it left behind, so its own
    // writes land here equal, as does per-device churn like theme.current — no
    // echo-suppression flag is needed.
    const localHash = await currentHash()
    const { meta: agreed, dirty } = await meta.get(['meta', 'dirty'])
    if (localHash === agreed.h)
      return

    await meta.set(dirty ? { dirty: true } : { dirty: true, dirtySince: now() })
    await scheduleAlarm()
  }

  /** `force` pushes over a newer cloud copy: the reader chose this browser's settings. */
  async function push({ force = false }: { force?: boolean } = {}): Promise<void> {
    const { enabled, meta: agreed, pause } = await meta.get(['enabled', 'meta', 'pause'])
    if (!enabled)
      return
    // While an update is held, pushing would answer the question for the reader.
    if (pause?.reason === 'held' && !force) {
      logger.log('push waits: an incoming update is held for the reader')
      return
    }

    const opts = await deps.readOptions()
    const pruned = pruneToSynced(opts, defaults)
    const localHash = hash(canonicalStringify(pruned))
    const remote = await readManifest()

    let decision = decidePush(agreed, remote, localHash, version())
    if (force && decision === 'pull')
      decision = 'push'
    logger.log('push decision', decision)
    if (decision === 'blocked') {
      await pauseFor({ reason: 'newer-version', remoteVersion: remote!.v })
      return
    }
    if (decision === 'wait') {
      await pauseFor({ reason: 'older-cloud', remoteVersion: remote!.v })
      return
    }
    if (decision === 'noop') {
      if (localHash === agreed.h)
        await meta.set({ dirty: false, dirtySince: 0 })
      return
    }
    if (decision === 'pull') {
      await pull()
      return
    }

    const token = `${await getDeviceId()}.${randomId()}`
    const newGen = Math.max(agreed.g, remote?.g ?? 0) + 1
    const { chunks, manifest } = await encode(opts, defaults, newGen, token, version())

    const currentItems = await sync.get(null)
    const { toSet, toRemove } = diffChunks(pickChunks(currentItems), chunks)

    try {
      await sync.set({ ...toSet, [MANIFEST_KEY]: manifest })
      if (toRemove.length)
        await sync.remove(toRemove)
    }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error('push failed', msg)
      // Don't advance meta and keep `dirty` set so a later change retries.
      await meta.set({ lastError: quotaHint(msg) })
      return
    }

    // Compare-after-write: confirm our write survived a possible same-gen race.
    const after = await readManifest()
    if (after && after.w === token) {
      await meta.set({
        meta: { g: newGen, h: localHash, w: token },
        dirty: false,
        dirtySince: 0,
        lastError: '',
        lastSyncAt: now(),
        ...(isVersionPause(pause) ? { pause: null } : {}),
      })
      logger.log('push ok, gen', newGen)
    }
    else {
      logger.warn('push lost a race; pulling the winner')
      await pull()
    }
  }

  /** `acceptLoss` applies an update the deletion guard would hold: the reader accepted it. */
  async function pull({ acceptLoss = false }: { acceptLoss?: boolean } = {}): Promise<void> {
    const { enabled, meta: agreed, pause } = await meta.get(['enabled', 'meta', 'pause'])
    if (!enabled)
      return

    const items = await sync.get(null)
    const remote = (items[MANIFEST_KEY] as Manifest | undefined) ?? null
    const decision = decidePull(agreed, remote, version())
    if (decision === 'blocked') {
      await pauseFor({ reason: 'newer-version', remoteVersion: remote!.v })
      return
    }
    if (decision === 'wait') {
      // Never adopt an older build's copy. A browser with agreed state of its
      // own replaces it (the push decides so); one without waits for one with.
      if (agreed.g > 0)
        await scheduleAlarm()
      else
        await pauseFor({ reason: 'older-cloud', remoteVersion: remote!.v })
      return
    }
    // A copy at this build's version: whatever paused for versions is over.
    if (isVersionPause(pause))
      await meta.set({ pause: null })
    if (decision === 'noop')
      return
    // The copy already held: nothing new to assess until something newer arrives.
    if (!acceptLoss && pause?.reason === 'held' && remote!.g === pause.g && remote!.w === pause.w)
      return

    const result = await decode(items, version())
    if (!result.ok) {
      if (result.reason === 'version') {
        await pauseFor({ reason: 'newer-version', remoteVersion: remote!.v })
        return
      }
      if (result.reason === 'empty')
        return
      // incomplete / corrupt: usually a half-propagated chunk set — retry briefly.
      if (pullRetries < MAX_PULL_RETRIES) {
        pullRetries++
        await alarms.create(ALARM_PULL_RETRY, { delayInMinutes: PULL_RETRY_MIN })
        logger.log('pull incomplete, retry', pullRetries)
      }
      else {
        pullRetries = 0
        await meta.set({ lastError: 'Could not read synced data (incomplete).' })
      }
      return
    }
    pullRetries = 0

    // Back up the pre-pull state, then apply only the keys that actually change.
    await backups.maybeDaily()
    const current = await deps.readOptions()
    // `remote.k` tells us which options the writing device knew about, so a device
    // on an older build can't silently reset (and wipe) ones it has never heard of.
    const desired = buildLocalUpdate(result.options, defaults, current, remote?.k)

    // An update that would take away a large share of the rules, marked works or
    // text replacements waits for the reader — see syncGuard.ts for why no key
    // list or version can make that call. Nothing is applied and the agreement
    // doesn't move, so this browser's pushes wait too.
    const loss = acceptLoss ? null : assessPull(current, desired)
    if (loss) {
      const { backupsEnabled } = await meta.get(['backupsEnabled'])
      if (backupsEnabled)
        await backups.create('sync-held')
      await meta.set({ pause: { reason: 'held', g: remote!.g, w: remote!.w, loss, at: now(), backedUp: backupsEnabled } })
      logger.warn('holding back a sync update that would remove', loss)
      return
    }

    const update = diffOptions(current, desired)
    if (Object.keys(update).length)
      await deps.writeOptions(update)

    // Agree on what this browser now holds, not on the payload's own hash. The
    // two differ whenever the payload carries something this build can't
    // reproduce — options it doesn't know, or ones a writer on an older build
    // left out — and treating that difference as a local edit is how a browser
    // that had just adopted a copy used to push it straight back, claiming
    // defaults for everything the copy lacked.
    await meta.set({
      meta: { g: remote!.g, h: await currentHash(), w: remote!.w },
      dirty: false,
      dirtySince: 0,
      lastError: '',
      lastSyncAt: now(),
      ...(pause?.reason === 'held' ? { pause: null } : {}),
    })
    logger.log('pull ok, gen', remote!.g)
  }

  async function enable(): Promise<SetSyncResult> {
    await getDeviceId()
    // Forget any prior agreement so the cloud copy is treated as authoritative.
    await meta.set({ meta: { g: 0, h: '', w: '' }, lastError: '', pause: null })

    const remote = await readManifest()
    if (remote && remote.v > version()) {
      // Refuse rather than pause: this browser was never syncing, so there's
      // nothing to resume, and a switch left on would suggest otherwise.
      await meta.set({ enabled: false })
      return { ok: false, reason: 'newer-version', remoteVersion: remote.v, version: version() }
    }
    // Adopting replaces local settings wholesale, now or once a compatible copy
    // arrives, so back them up first (a deliberate destructive adopt).
    if (remote && (await meta.get(['backupsEnabled'])).backupsEnabled)
      await backups.create('pre-sync')
    if (remote && remote.v < version()) {
      // Not adopted, and not seeded over either: nothing here has been agreed.
      await meta.set({ pause: { reason: 'older-cloud', remoteVersion: remote.v } })
      return { ok: true }
    }
    if (remote) {
      await pull()
    }
    else {
      await push() // seed the cloud from this device
    }
    return { ok: true }
  }

  async function disable(): Promise<SetSyncResult> {
    await alarms.clear(ALARM_PUSH)
    await alarms.clear(ALARM_PULL_RETRY)
    await meta.set({ dirty: false, dirtySince: 0, pause: null })
    // Cloud data is intentionally left intact — clearing would wipe other devices.
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Record a version pause, unless it's already recorded. A held update keeps
   * its place over `older-cloud`: the question it asks the reader still stands,
   * and answering it is what moves this browser on.
   */
  async function pauseFor(next: Extract<SyncPause, { reason: 'newer-version' | 'older-cloud' }>): Promise<void> {
    const { pause } = await meta.get(['pause'])
    if (pause?.reason === 'held' && next.reason === 'older-cloud')
      return
    if (isDeepEqual(pause, next))
      return
    await meta.set({ pause: next })
    logger.warn('sync paused', next)
  }

  async function currentHash(): Promise<string> {
    return hash(canonicalStringify(pruneToSynced(await deps.readOptions(), defaults)))
  }

  async function readManifest(): Promise<Manifest | null> {
    const got = await sync.get(MANIFEST_KEY)
    return (got[MANIFEST_KEY] as Manifest | undefined) ?? null
  }

  async function scheduleAlarm(): Promise<void> {
    if (await alarms.get(ALARM_PUSH)) {
      // Don't keep deferring forever — once past the ceiling, let the pending alarm fire.
      const { dirtySince } = await meta.get(['dirtySince'])
      if (now() - dirtySince > MAX_WAIT_MS)
        return
    }
    await alarms.create(ALARM_PUSH, { delayInMinutes: DEBOUNCE_MIN })
  }

  async function getDeviceId(): Promise<string> {
    let { deviceId: id } = await meta.get(['deviceId'])
    if (!id) {
      id = randomId()
      await meta.set({ deviceId: id })
    }
    return id
  }

  return { onStorageChanged, onAlarm, start, init, setEnabled, resolveHeld, clearSyncedData, getUsage, getStatus, idle }
}

export type SyncEngine = ReturnType<typeof createSyncEngine>

/** A pause that lifts once this browser and the cloud copy speak the same sync version. */
function isVersionPause(pause: SyncPause | null): boolean {
  return pause?.reason === 'newer-version' || pause?.reason === 'older-cloud'
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

function quotaHint(msg: string): string {
  return /quota/i.test(msg)
    ? 'Settings are too large to sync — reduce filter lists or text replacements.'
    : `Sync failed: ${msg}`
}
