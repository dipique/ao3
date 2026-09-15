import type { Manifest } from './syncCodec.ts'

import { SYNC_SCHEMA_VERSION } from './syncCodec.ts'

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
