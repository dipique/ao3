import { isDeepEqual } from '@antfu/utils'

import type { BackupKind, HeldAnswer, SetSyncResult } from './api.ts'
import type { Options } from './options.ts'
import type { Manifest } from './syncCodec.ts'
import type { CopyRead, Inconsistency } from './syncConsistency.ts'
import type { SyncMeta, SyncPause } from './syncMeta.ts'

import { buildLocalUpdate, canonicalStringify, decode, diffChunks, diffOptions, encode, hash, MANIFEST_KEY, pruneToSynced, QUOTA_BYTES, SYNC_SCHEMA_VERSION } from './syncCodec.ts'
import { checkCopy, keepRefusal, nextInconsistency, ownCopyReplaces, readOf, recheckIn } from './syncConsistency.ts'
import { decideFirstPull, decidePull, decidePush, questionGone, uploadId, weighCopy } from './syncDecide.ts'
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
/** Reads the synced copy again once a copy that can't be read whole has been waited on. */
export const ALARM_CONSISTENCY = 'ao3e-sync-consistency'
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
    /**
     * Snapshot `snapshot`, or the current options when it's absent. Resolves
     * once a backup holds them: a new one, or the newest of its kind where that
     * holds the same already. Rejects when one has to be written and isn't.
     */
    create: (kind: BackupKind, snapshot?: Partial<Options>) => Promise<void>
  }
  /**
   * Bring this browser's own options into line before a pull is weighed against
   * them and applied: the saved-list planner, which moves an entry that isn't
   * tracked out of `trackedLists` and into a record that never syncs. A pull
   * replaces `trackedLists` whole, so one that arrived before the migration had
   * moved them would take those lists, titles and all, with it.
   */
  prePull?: () => Promise<void>
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
    else if (alarm.name === ALARM_CONSISTENCY)
      void withLock(recheck)
  }

  /**
   * As the wait on a copy that couldn't be read whole ends: read the store
   * itself, then pull. The pull doesn't read again a copy it has already
   * weighed, whose parts may have changed since.
   */
  async function recheck(): Promise<void> {
    await readStore()
    await pull()
  }

  /**
   * Run every time the worker starts, whatever woke it: re-arm a push that was
   * pending when the last one stopped, and the read again of a synced copy
   * that couldn't be read whole. Alarms don't reliably survive an extension
   * reload (which an import does straight after writing options), and nothing
   * else notices a browser still marked dirty, or a copy that never changes.
   */
  async function start(): Promise<void> {
    await withLock(async () => {
      const { enabled, dirty, staleBuild, inconsistent } = await meta.get(['enabled', 'dirty', 'staleBuild', 'inconsistent'])
      if (!enabled || staleBuild)
        return
      if (dirty && !(await alarms.get(ALARM_PUSH)))
        await scheduleAlarm()
      if (!(await alarms.get(ALARM_CONSISTENCY)))
        await armRecheck(inconsistent)
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

  /**
   * Off at once, so nothing already queued syncs, and again in its turn, so a
   * turning-on queued ahead of it can't leave sync on. On only in its turn, so
   * nothing already queued runs on the agreement that turning on forgets.
   */
  async function setEnabled(enabled: boolean): Promise<SetSyncResult> {
    if (enabled)
      return withLock(enable)
    await meta.set({ enabled })
    return withLock(disable)
  }

  /** Explicit "forget the cloud copy" action — removes this extension's sync keys. */
  async function clearSyncedData(): Promise<void> {
    await withLock(async () => {
      const items = await sync.get(null)
      const keys = Object.keys(items).filter(k => k === MANIFEST_KEY || isChunkKey(k))
      if (keys.length)
        await sync.remove(keys)
      await meta.set({ meta: { g: 0, h: '', w: '' }, dirty: false, dirtySince: 0, lastError: '', lastSyncAt: 0 })
      await noteCopy('none')
    })
  }

  /**
   * The reader's answer to the question sync holds for: an update the deletion
   * guard held, or which settings to keep over a copy that differs, as sync
   * turned on or when another browser started a copy of its own. `accept`
   * applies the synced copy. This browser's settings were backed up as the
   * question was asked, if `pause.backedUp` says so, and are backed up again
   * first, under the same kind, since edits made while it asked are in no
   * backup yet. With none made, the backup it points to already holds them,
   * and no second one is written. `keep` saves the synced copy as a backup, so
   * whatever the other browser had is still restorable, and pushes this
   * browser's settings over it, under the copy's ID.
   *
   * `keep` is refused while the synced copy can't be read whole, since it
   * can't be backed up: nothing is backed up, sent or cleared.
   */
  async function resolveHeld(choice: 'accept' | 'keep'): Promise<HeldAnswer> {
    return withLock(async () => {
      const { pause } = await meta.get(['pause'])
      if (!isQuestion(pause))
        return { resolved: false }

      if (choice === 'accept') {
        await backUp(questionBackupKind(pause))
        await pull({ acceptLoss: true })
      }
      else {
        const items = await sync.get(null)
        const partly = await noteCopy((await checkCopy(items, version())).read)
        if (partly)
          return { resolved: false, refused: keepRefusal(partly) }
        const result = await decode(items, version())
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
      if (isQuestion((await meta.get(['pause'])).pause))
        await meta.set({ pause: null })
      return { resolved: true }
    })
  }

  /**
   * The reader's answer to synced settings that still can't be read whole
   * past the wait: replace them with this browser's, under a new ID, so every
   * browser that agreed with them weighs this browser's settings as a copy
   * another browser started, asking where its own differ. Only while the copy
   * still can't be read whole, and this browser's own settings can replace it
   * (`ownCopyReplaces`). Answers whether they were sent.
   */
  async function replaceSyncedCopy(): Promise<boolean> {
    return withLock(async () => {
      const record = await readStore()
      if (!record?.replaceable)
        return false
      await push({ fresh: true })
      return !(await meta.get(['inconsistent'])).inconsistent
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

    const { enabled, pause, staleBuild } = await meta.get(['enabled', 'pause', 'staleBuild'])
    if (!enabled || staleBuild)
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

  /**
   * `force` pushes over a newer cloud copy, under its ID: the reader chose
   * this browser's settings, or the copy held nothing beyond defaults.
   * `fresh` pushes over a copy that can't be read whole, under a new ID: the
   * reader chose to replace it. Once it lands, a question asked over the copy
   * it replaced is over.
   */
  async function push({ force = false, fresh = false }: { force?: boolean, fresh?: boolean } = {}): Promise<void> {
    const { enabled, meta: agreed, pause, staleBuild, inconsistent } = await meta.get(['enabled', 'meta', 'pause', 'staleBuild', 'inconsistent'])
    if (!enabled || staleBuild)
      return
    // While the reader is asked whether to take the synced settings, pushing would answer for them.
    if (isQuestion(pause) && !force && !fresh) {
      logger.log('push waits: the reader has yet to answer', pause.reason)
      return
    }

    const opts = await deps.readOptions()
    const pruned = pruneToSynced(opts, defaults)
    const localHash = hash(canonicalStringify(pruned))
    const remote = await readManifest()

    let decision = decidePush(agreed, remote, localHash, version())
    if ((force || fresh) && decision === 'pull')
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

    const device = await getDeviceId()
    const token = `${device}.${randomId()}`
    const newGen = Math.max(agreed.g, remote?.g ?? 0) + 1
    const id = fresh ? newCopyId(device) : uploadId(agreed, remote, force, () => newCopyId(device), version())
    const { chunks, manifest } = await encode(opts, defaults, newGen, token, version(), id)

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
      // The synced copy is this browser's own now, whole.
      await meta.set({
        meta: { g: newGen, h: localHash, w: token, ...(id ? { i: id } : {}) },
        dirty: false,
        dirtySince: 0,
        lastError: '',
        lastSyncAt: now(),
        ...(isVersionPause(pause) || (fresh && isQuestion(pause)) ? { pause: null } : {}),
      })
      if (inconsistent)
        await noteCopy('whole')
      logger.log('push ok, gen', newGen)
    }
    else {
      logger.warn('push lost a race; pulling the winner')
      await pull()
    }
  }

  /**
   * `acceptLoss` applies the copy whatever the deletion guard says, or whatever
   * the first pull would ask: the reader accepted it. `firstBackup` is the
   * backup turning sync on took, for the question if the first pull asks one.
   */
  async function pull({ acceptLoss = false, firstBackup }: { acceptLoss?: boolean, firstBackup?: BackupRecord } = {}): Promise<void> {
    const { enabled, meta: agreed, pause, staleBuild, inconsistent } = await meta.get(['enabled', 'meta', 'pause', 'staleBuild', 'inconsistent'])
    if (!enabled || staleBuild)
      return

    const items = await sync.get(null)
    const remote = (items[MANIFEST_KEY] as Manifest | undefined) ?? null
    const decision = decidePull(agreed, remote, version())
    // A copy at another sync version isn't read whole: an older one is never
    // taken, a newer one pauses sync. Nothing at this version is left to wait on.
    if (decision === 'blocked' || decision === 'wait' || !remote)
      await noteCopy('none')
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
    if (decision === 'noop') {
      // The copy another browser started gave way to this browser's own: there
      // is nothing left to answer, and what was edited meanwhile can go out.
      if (questionGone(pause, agreed, remote)) {
        await meta.set({ pause: null })
        logger.log('the synced copy asked about gave way to this browser\'s own')
        if ((await meta.get(['dirty'])).dirty)
          await scheduleAlarm()
      }
      return
    }
    // The copy already asked about: nothing new to assess until something newer
    // arrives. Its parts can still change under it: once it has been read
    // partial it is read again, and read whole it ends the record.
    if (!acceptLoss && isQuestion(pause) && remote!.g === pause.g && remote!.w === pause.w) {
      if (inconsistent)
        await noteCopy((await checkCopy(items, version())).read)
      return
    }

    const result = await decode(items, version())
    await noteCopy(readOf(result))
    if (!result.ok) {
      if (result.reason === 'version') {
        await pauseFor({ reason: 'newer-version', remoteVersion: remote!.v })
        return
      }
      if (result.reason === 'empty')
        return
      // incomplete / corrupt: usually a half-propagated chunk set — retry
      // briefly, and read it again once it has been waited on.
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

    await deps.prePull?.()
    const current = await deps.readOptions()
    // `remote.k` tells us which options the writing device knew about, so a device
    // on an older build can't silently reset (and wipe) ones it has never heard of.
    const desired = buildLocalUpdate(result.options, defaults, current, remote?.k)

    // Nothing agreed yet, as after turning sync on, or a copy another browser
    // started under an ID of its own: adopting it would replace settings this
    // browser has never shared, so where both hold settings of their own that
    // differ, the reader chooses. The question stands in for the deletion
    // guard, and nothing is applied or pushed until it is answered. Every
    // outcome agrees on the copy's ID.
    const weight = weighCopy(agreed, remote!)
    if (weight.weigh !== 'update' && !acceptLoss) {
      const first = decideFirstPull(current, result.options, defaults, remote!.k)
      if (first.kind === 'send') {
        if (isQuestion(pause))
          await meta.set({ pause: null })
        await push({ force: true })
        return
      }
      if (first.kind === 'ask') {
        const otherCopy = weight.weigh === 'other'
        // Asked again over a newer copy, the backup taken as it first asked still stands.
        const backup = firstBackup
          ?? (pause?.reason === 'first-sync' && !!pause.otherCopy === otherCopy
            ? { backedUp: pause.backedUp, backupFailed: pause.backupFailed }
            : await backUp(otherCopy ? 'sync-held' : 'pre-sync'))
        await meta.set({ pause: { reason: 'first-sync', g: remote!.g, w: remote!.w, at: now(), ...backup, loss: first.loss, ...(otherCopy ? { otherCopy } : {}) } })
        logger.warn(otherCopy
          ? 'asking which settings to keep: another browser started a synced copy that differs from this browser\'s own'
          : 'asking which settings to keep: the synced copy differs from this browser\'s own')
        return
      }
    }

    // An update that would take away a large share of the rules, marked works or
    // text replacements waits for the reader — see syncGuard.ts for why no key
    // list or version can make that call. Nothing is applied and the agreement
    // doesn't move, so this browser's pushes wait too. Accepting it replaces
    // every setting here, so they're backed up as it's held.
    const loss = acceptLoss ? null : assessPull(current, desired)
    if (loss) {
      const backup = await backUp('sync-held')
      await meta.set({ pause: { reason: 'held', g: remote!.g, w: remote!.w, loss, at: now(), ...backup } })
      logger.warn('holding back a sync update that would remove', loss)
      return
    }

    // Back up the day's first state, then apply only the keys that actually
    // change. Only past the guard: a held update changes nothing, so a daily
    // backup that can't be written mustn't keep it from being held.
    await backups.maybeDaily()
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
      meta: { g: remote!.g, h: await currentHash(), w: remote!.w, ...(weight.id ? { i: weight.id } : {}) },
      dirty: false,
      dirtySince: 0,
      lastError: '',
      lastSyncAt: now(),
      ...(isQuestion(pause) ? { pause: null } : {}),
    })
    logger.log('pull ok, gen', remote!.g)
  }

  async function enable(): Promise<SetSyncResult> {
    await getDeviceId()
    // Forget any prior agreement, so the first pull weighs the cloud copy
    // against this browser's settings afresh. The ID turning sync off gave
    // this browser stays: it seeds under it, or takes the ID of whichever copy
    // it joins, and keeps it over a copy that has none.
    const { meta: { i } } = await meta.get(['meta'])
    await meta.set({ enabled: true, meta: { g: 0, h: '', w: '', ...(i ? { i } : {}) }, lastError: '', pause: null })
    await noteCopy('none')

    const remote = await readManifest()
    if (!remote) {
      await push() // seed the cloud from this device
      return { ok: true }
    }
    if (remote.v > version()) {
      // Refuse rather than pause: this browser was never syncing, so there's
      // nothing to resume, and a switch left on would suggest otherwise.
      await meta.set({ enabled: false })
      return { ok: false, reason: 'newer-version', remoteVersion: remote.v, version: version() }
    }
    // The copy can replace every setting here, now or once a compatible copy
    // arrives, so they are backed up first, whatever daily backups say.
    const backup = await backUp('pre-sync')
    if (remote.v < version()) {
      // Not adopted, and not seeded over either: nothing here has been agreed.
      await meta.set({ pause: { reason: 'older-cloud', remoteVersion: remote.v } })
      return { ok: true }
    }
    await pull({ firstBackup: backup })
    return { ok: true }
  }

  /**
   * Turning sync off gives this browser a new ID: once sync is on again, it
   * seeds a copy under it, or keeps it over a copy that has none, and its
   * next upload puts it there.
   */
  async function disable(): Promise<SetSyncResult> {
    await alarms.clear(ALARM_PUSH)
    await alarms.clear(ALARM_PULL_RETRY)
    await noteCopy('none')
    const { meta: agreed } = await meta.get(['meta'])
    await meta.set({ enabled: false, dirty: false, dirtySince: 0, pause: null, meta: { ...agreed, i: newCopyId(await getDeviceId()) } })
    // Cloud data is intentionally left intact — clearing would wipe other devices.
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Back up this browser's settings where sync may replace every one of them,
   * whatever daily backups say: as an update is held, as sync turns on over a
   * synced copy, as it asks about a copy another browser started, and as any
   * of those questions is answered by taking the synced settings. Answers what
   * to record of it: one that can't be written doesn't stop what it guards,
   * which then records that it failed. Settings the newest backup of the kind
   * already holds count as backed up: that backup is the one kept for them.
   */
  async function backUp(kind: BackupKind): Promise<BackupRecord> {
    try {
      await backups.create(kind)
      return { backedUp: true, backupFailed: false }
    }
    catch (e) {
      logger.error(`going on without a ${kind} backup: it could not be written`, e)
      return { backedUp: false, backupFailed: true }
    }
  }

  /**
   * Record what a read of the synced copy found (`sync.inconsistent`): when a
   * copy that can't be read whole was first read so, and once the wait is up,
   * whether this browser's own settings can replace it. The first such read
   * sets an alarm to read it again when the wait is up, since a copy whose
   * rest never arrives changes nothing that would wake the engine. Answers the
   * record: null unless the copy was read partial.
   */
  async function noteCopy(read: CopyRead): Promise<Inconsistency | null> {
    const { inconsistent } = await meta.get(['inconsistent'])
    if (read !== 'partial' && !inconsistent)
      return null
    const ownReplaces = read === 'partial' && await ownCopyReplaces(await deps.readOptions(), defaults, version())
    const next = nextInconsistency(inconsistent, read, now(), ownReplaces)
    if (!isDeepEqual(next, inconsistent)) {
      await meta.set({ inconsistent: next })
      if (next?.overdue)
        logger.warn('the synced copy still can\'t be read whole past the wait')
    }
    if (!next)
      await alarms.clear(ALARM_CONSISTENCY)
    else if (!inconsistent)
      await armRecheck(next)
    return next
  }

  /** Read the synced store as it stands, and record what was found, while sync is on. */
  async function readStore(): Promise<Inconsistency | null> {
    const { enabled, staleBuild } = await meta.get(['enabled', 'staleBuild'])
    if (!enabled || staleBuild)
      return null
    return noteCopy((await checkCopy(await sync.get(null), version())).read)
  }

  /** Read the synced copy again once `record`'s wait is up. */
  async function armRecheck(record: Inconsistency | null): Promise<void> {
    const wait = recheckIn(record, now())
    if (wait !== null)
      await alarms.create(ALARM_CONSISTENCY, { delayInMinutes: wait / 60_000 })
  }

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

  /** A new ID for a synced copy, as unique as a writer token: the device's ID and a random part. */
  function newCopyId(device: string): string {
    return `${device}.${randomId()}`
  }

  async function getDeviceId(): Promise<string> {
    let { deviceId: id } = await meta.get(['deviceId'])
    if (!id) {
      id = randomId()
      await meta.set({ deviceId: id })
    }
    return id
  }

  return { onStorageChanged, onAlarm, start, init, setEnabled, resolveHeld, replaceSyncedCopy, clearSyncedData, getUsage, getStatus, idle }
}

export type SyncEngine = ReturnType<typeof createSyncEngine>

/** A pause that waits on the reader's answer: nothing is applied or pushed until they give it. */
type Question = Extract<SyncPause, { reason: 'held' | 'first-sync' }>

/** What a question records of the backup taken for it. */
type BackupRecord = Pick<Extract<SyncPause, { reason: 'first-sync' }>, 'backedUp' | 'backupFailed'>

function isQuestion(pause: SyncPause | null): pause is Question {
  return pause?.reason === 'held' || pause?.reason === 'first-sync'
}

/** The kind a question's backups are kept as: turning sync on's are `pre-sync`; any other is asked while sync is on, and holds the copy. */
function questionBackupKind(pause: Question): BackupKind {
  return pause.reason === 'first-sync' && !pause.otherCopy ? 'pre-sync' : 'sync-held'
}

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

function quotaHint(msg: string): string {
  return /quota/i.test(msg)
    ? 'Settings are too large to sync — reduce filter lists or text replacements.'
    : `Sync failed: ${msg}`
}
