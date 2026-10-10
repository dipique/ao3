import type { Options } from './options.ts'
import type { Manifest } from './syncCodec.ts'
import type { PullLoss } from './syncGuard.ts'
import type { SyncPause } from './syncMeta.ts'

import { buildLocalUpdate, diffOptions, pruneToSynced, SYNC_SCHEMA_VERSION } from './syncCodec.ts'
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
 * Where either side has no ID, the copy is an update. A copy with none was
 * written by a build from before the ID, over whichever copy it had agreed
 * with, which can't be told. A browser with none synced on such a build, and
 * can't say which copy it agreed with either: it takes the first copy that
 * has one as an update, so out-of-date settings without an ID give way to a
 * copy with one.
 */
export function weighCopy(agreed: LocalMeta, copy: Pick<Manifest, 'i'>): CopyWeight {
  const id = copy.i ?? agreed.i
  if (agreed.g === 0)
    return id ? { weigh: 'first', id } : { weigh: 'first' }
  if (!copy.i)
    return id ? { weigh: 'update', id } : { weigh: 'update' }
  if (agreed.i && agreed.i !== copy.i)
    return { weigh: 'other', id: copy.i }
  return { weigh: 'update', id: copy.i }
}

/**
 * The ID an upload writes on the synced copy, which the agreement takes once
 * the upload lands. `force` is one the reader chose over the copy, or one
 * sent over a copy holding nothing beyond defaults: it goes under the copy's
 * ID, so the browsers that agreed with that copy take it as an update.
 *
 * Otherwise it is the agreed ID. A browser with none writes over the copy it
 * agreed with under that copy's ID, which a build from before the ID agreed
 * with but didn't record, and writes none over a copy at this sync version
 * that has none, so it syncs with builds from before the ID as it did. Over
 * an empty store, or a copy at an older sync version, which is never adopted,
 * it starts a copy of its own, and over a copy whose ID it never agreed with
 * (an older generation, which isn't pulled) it writes over one another
 * browser started: each under a new ID, from `fresh`.
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
 * Whether the question a copy under another ID raised has gone: the cloud
 * holds a copy under this browser's agreed ID again, its own seed landing
 * after the other browser's, say. The copy it asked about isn't there to
 * use or keep.
 */
export function questionGone(pause: SyncPause | null, agreed: LocalMeta, remote: Manifest | null): boolean {
  return pause?.reason === 'first-sync' && pause.otherCopy === true && !!agreed.i && remote?.i === agreed.i
}
