import type { Options } from './options.ts'
import type { Line, Manifest, Upload } from './syncCodec.ts'
import type { PullLoss } from './syncGuard.ts'
import type { SyncPause } from './syncMeta.ts'

import { buildLocalUpdate, diffOptions, lineOf, pruneToSynced, SYNC_SCHEMA_VERSION } from './syncCodec.ts'
import { assessPull } from './syncGuard.ts'

/**
 * Pure conflict-resolution logic, kept browser-free so every interleaving can be
 * unit-tested headlessly. The engine ({@link file://./syncCore.ts}) is a thin
 * I/O shell that reads state, calls these, and acts on the verdict.
 *
 * Invariant: the generation counter is a *monotonic hint*, never a version
 * identity. Two devices can race to the same generation with different content;
 * the writer token `w` is the tie-breaker, and the engine confirms a push with a
 * read-back (compare-after-write) so a lost race converges to a pull instead of
 * silently diverging.
 *
 * **The sync version gates everything else.** A cloud copy written at a higher
 * {@link SYNC_SCHEMA_VERSION} than this build's is `'blocked'`: this build can't
 * be trusted to read it or to write over it, so it waits to be updated. A copy
 * written at a lower version is never adopted — the build that wrote it didn't
 * know everything this one syncs, and adopting its copy is how a browser comes
 * to hold defaults it then pushes as fact. A browser that has synced before
 * overwrites such a copy with its own state (moving the cloud up to its version);
 * one that never has `'wait'`s for a browser that can.
 */

export interface LocalMeta {
  /** generation this device's working copy last agreed with */
  g: number
  /** content hash this device last agreed with */
  h: string
  /** writer token this device last agreed with */
  w: string
  /**
   * ID of the synced copy this device last agreed with ({@link Manifest.i}),
   * kept over a copy that carries none. Turning sync off replaces it with a
   * new one, which the browser keeps until it agrees with a copy that has an
   * ID. Absent on a browser that synced on a build from before the ID and has
   * met no copy with one since.
   */
  i?: string
  /**
   * The *Keep* the agreed upload's line comes from ({@link Manifest.p}),
   * which this browser's next upload carries on, as it does `o`. Where it is
   * this browser's own *Keep* (or its settings sent over a copy holding
   * nothing beyond defaults), a copy under the agreed ID that never saw it is
   * weighed as one another browser started (see {@link weighCopy}). An
   * agreement from before the line carries none, and remembers no *Keep*.
   */
  p?: Upload
  /** The agreed upload's {@link Manifest.o}. */
  o?: Upload
}

export type Decision = 'noop' | 'push' | 'pull' | 'blocked' | 'wait'

/** Is the remote payload a version this device's working copy hasn't adopted yet? */
export function isRemoteNewer(remote: Manifest, local: LocalMeta): boolean {
  if (remote.g !== local.g)
    return remote.g > local.g
  // Same generation but a different writer token => a same-gen overwrite race.
  // Resolve deterministically (lexicographically larger token wins) so every
  // device converges on the same winner.
  if (remote.w !== local.w)
    return remote.w > local.w
  return false
}

/**
 * Decide what a push attempt should actually do. `localHash` is the hash of the
 * current pruned local options (compared against `local.h` to detect changes);
 * `version` is the sync version this build speaks.
 */
export function decidePush(local: LocalMeta, remote: Manifest | null, localHash: string, version = SYNC_SCHEMA_VERSION): Decision {
  if (remote && remote.v > version)
    return 'blocked'
  // An older build's copy: replace it if this browser holds agreed state of its
  // own, whether or not anything changed here.
  if (remote && remote.v < version)
    return local.g > 0 ? 'push' : 'wait'

  const hasLocalChanges = localHash !== local.h
  if (!hasLocalChanges)
    return remote && isRemoteNewer(remote, local) ? 'pull' : 'noop'

  // We have unpushed local changes, but if the cloud advanced under us, adopt it
  // first (higher generation wins; the local change survives in a backup).
  if (remote && isRemoteNewer(remote, local))
    return 'pull'

  return 'push'
}

/** Decide whether an observed sync change is worth pulling. */
export function decidePull(local: LocalMeta, remote: Manifest | null, version = SYNC_SCHEMA_VERSION): Decision {
  if (!remote)
    return 'noop'
  if (remote.v > version)
    return 'blocked'
  if (remote.v < version)
    return 'wait'
  return isRemoteNewer(remote, local) ? 'pull' : 'noop'
}

export type FirstPull
  /** The copy holds nothing beyond defaults, and this browser does: its settings are sent over the copy. */
  = | { kind: 'send' }
  /** This browser holds nothing beyond defaults: the copy is adopted. */
    | { kind: 'adopt' }
  /** Adopting the copy would change nothing here. */
    | { kind: 'agree' }
  /**
   * Both hold settings of their own, and they differ: the reader is asked which
   * to keep. `loss` is what adopting the copy would remove where the deletion
   * guard would hold it.
   */
    | { kind: 'ask', loss: PullLoss | null }

/**
 * What the first pull a browser makes with nothing agreed does with the synced
 * copy (`copy`, decoded; `writerKeys`, its manifest's `k`). That is the pull
 * that turning sync on makes, since turning it on forgets any agreement.
 *
 * Adopting a copy replaces every setting here, which is ruinous where this
 * browser holds settings of its own that the copy doesn't, so then the reader
 * chooses. Where neither side loses anything there is nothing to ask: a copy
 * holding nothing beyond defaults (a browser that turned sync on untouched)
 * takes this browser's settings, a browser holding nothing beyond defaults (a
 * new profile) takes the copy, and a copy that would change nothing here is
 * agreed on as it stands. Device-local settings are this browser's alone, and
 * count for neither.
 */
export function decideFirstPull(current: Options, copy: Partial<Options>, defaults: Options, writerKeys?: string[]): FirstPull {
  const holdsSettings = Object.keys(pruneToSynced(current, defaults)).length > 0
  if (Object.keys(copy).length === 0 && holdsSettings)
    return { kind: 'send' }
  const desired = buildLocalUpdate(copy, defaults, current, writerKeys)
  if (Object.keys(diffOptions(current, desired)).length === 0)
    return { kind: 'agree' }
  if (!holdsSettings)
    return { kind: 'adopt' }
  return { kind: 'ask', loss: assessPull(current, desired) }
}

export type CopyWeight
  /**
   * Nothing agreed yet, as sync turns on: {@link decideFirstPull} weighs the
   * copy, whatever its ID. A copy with none leaves this browser the ID turning
   * sync off gave it.
   */
  = | { weigh: 'first', id?: string }
  /**
   * A copy under an ID other than the agreed one: another browser started a
   * synced copy of its own. Taken as an update, it would replace every
   * setting here, so {@link decideFirstPull} weighs it, as it weighs a copy
   * when sync turns on.
   */
    | { weigh: 'other', id: string }
  /** An update to the copy agreed with, or one whose ID can't say otherwise: applied past the deletion guard. */
    | { weigh: 'update', id?: string }

/**
 * How a copy the pull takes is weighed, from the copy's ID and the agreed
 * one. `id` is the ID the agreement takes once it agrees with the copy, by any
 * answer: the copy's, or for a copy without one this browser's own, which its
 * next upload puts on the copy.
 *
 * Where either side has no ID, the copy is an update. A copy with none can't
 * say which copy it was written over. A browser with none synced on a build
 * from before the ID, and can't say which copy it agreed with either: it
 * takes the first copy that has one as an update, so out-of-date settings
 * without an ID give way to a copy with one.
 *
 * Under the agreed ID, where the agreed line comes from this browser's
 * own *Keep*, a copy that never saw that *Keep* is weighed as one another
 * browser started: two browsers that answered *Keep* over one copy before
 * either received the other's upload both uploaded under its ID. `device` is
 * this browser's ID, which tells its own *Keep* apart.
 */
export function weighCopy(agreed: LocalMeta, copy: Pick<Manifest, 'i'> & Line, device = ''): CopyWeight {
  const id = copy.i ?? agreed.i
  if (agreed.g === 0)
    return id ? { weigh: 'first', id } : { weigh: 'first' }
  if (!copy.i)
    return id ? { weigh: 'update', id } : { weigh: 'update' }
  if (agreed.i && agreed.i !== copy.i)
    return { weigh: 'other', id: copy.i }
  const kept = ownKeep(agreed, device)
  if (kept && !sawKeep(kept, copy))
    return { weigh: 'other', id: copy.i }
  return { weigh: 'update', id: copy.i }
}

/** A writer token: the writing device's ID and a random part, so every upload writes one of its own. */
export function writerToken(device: string, random: string): string {
  return `${device}.${random}`
}

/**
 * The line an upload carries ({@link Line}). A *Keep*, or settings sent over
 * a copy holding nothing beyond defaults, starts one of its own: `keep` is
 * that upload, chosen over a copy whose line is `over`. Any other upload
 * carries on the line of `agreed`, the upload its writer agreed with.
 */
export function uploadLine(agreed: Line, keep?: { upload: Upload, over: Line }): Line {
  if (keep)
    return lineOf({ p: keep.upload, o: keep.over.p })
  return lineOf(agreed)
}

/** This browser's own *Keep*, where the line it agrees with comes from one. */
function ownKeep(agreed: LocalMeta, device: string): Upload | undefined {
  return agreed.p?.w.startsWith(writerToken(device, '')) ? agreed.p : undefined
}

/**
 * Whether `copy` saw the *Keep* `kept`: its line comes from it, or from
 * a *Keep* chosen over a copy whose line did.
 */
function sawKeep(kept: Upload, copy: Line): boolean {
  return [copy.p, copy.o].some(upload => upload?.g === kept.g && upload.w === kept.w)
}

/**
 * The ID an upload writes on the synced copy, which the agreement takes once
 * the upload lands. `force` is one the reader chose over the copy, or one
 * sent over a copy holding nothing beyond defaults: it goes under the copy's
 * ID, so the browsers that agreed with that copy take it as an update.
 *
 * Otherwise it is the agreed ID. A browser with none writes over the copy it
 * agreed with under that copy's ID, which a build from before the ID agreed
 * with but didn't record, and none over a copy at this sync version that has
 * none, which can't say which copy it was written over either. Over an empty
 * store, or a copy at an older sync version, which is never adopted, it
 * starts a copy of its own, and over a copy whose ID it never agreed with (an
 * older generation, which isn't pulled) it writes over one another browser
 * started: each under a new ID, from `fresh`.
 */
export function uploadId(agreed: LocalMeta, remote: Manifest | null, force: boolean, fresh: () => string, version = SYNC_SCHEMA_VERSION): string | undefined {
  if (force && remote?.i)
    return remote.i
  if (agreed.i)
    return agreed.i
  if (remote?.i && remote.g === agreed.g && remote.w === agreed.w)
    return remote.i
  if (remote && !remote.i && remote.v >= version)
    return undefined
  return fresh()
}

/**
 * Whether the question a copy another browser started raised has gone: the
 * cloud holds a copy under this browser's agreed ID again, one that saw its
 * own *Keep* where its line comes from one: its own seed landing after the
 * other browser's, say, or its own *Keep* upload after one that never saw
 * it. The engine asks only of a copy no newer than its agreement. The copy it
 * asked about isn't there to use or keep.
 */
export function questionGone(pause: SyncPause | null, agreed: LocalMeta, remote: Manifest | null, device = ''): boolean {
  return pause?.reason === 'first-sync' && pause.otherCopy === true && !!agreed.i && remote?.i === agreed.i
    && weighCopy(agreed, remote, device).weigh === 'update'
}

/** A pause that waits on the reader's answer: nothing is applied or pushed until they give it. */
export type Question = Extract<SyncPause, { reason: 'held' | 'first-sync' }>

/**
 * Whether taking the synced settings is refused, where the backups it takes
 * of this browser's settings as it applies them were `written` or not: the
 * question to record if it is, else null. A backup that would repeat the
 * newest of its kind counts as written, since that one holds them.
 *
 * Where one was due and couldn't be written, the first press applies nothing,
 * and the question records that this browser's settings aren't backed up, so
 * it says so. Once it says so, the reader answers knowing it, and a press goes
 * ahead whatever its backups do.
 */
export function refuseUnbacked(pause: Question, written: boolean): Question | null {
  if (written || pause.backupFailed)
    return null
  return { ...pause, backedUp: false, backupFailed: true }
}
