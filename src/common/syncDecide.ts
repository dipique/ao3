import type { Manifest } from './syncCodec.ts'

import { SYNC_SCHEMA_VERSION } from './syncCodec.ts'

/**
 * Pure conflict-resolution logic, kept browser-free so every interleaving can be
 * unit-tested headlessly. The engine ({@link file://./../background/syncEngine.ts})
 * is a thin I/O shell that reads state, calls these, and acts on the verdict.
 *
 * Invariant: the generation counter is a *monotonic hint*, never a version
 * identity. Two devices can race to the same generation with different content;
 * the writer token `w` is the tie-breaker, and the engine confirms a push with a
 * read-back (compare-after-write) so a lost race converges to a pull instead of
 * silently diverging.
 */

export interface LocalMeta {
  /** generation this device's working copy last agreed with */
  g: number
  /** content hash this device last agreed with */
  h: string
  /** writer token this device last agreed with */
  w: string
}

export type Decision = 'noop' | 'push' | 'pull'

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
 * current pruned local options (compared against `local.h` to detect changes).
 */
export function decidePush(local: LocalMeta, remote: Manifest | null, localHash: string): Decision {
  // Can't safely act on a newer on-the-wire schema: pushing would downgrade it,
  // pulling can't decode it. Wait for this device to update.
  if (remote && remote.v > SYNC_SCHEMA_VERSION)
    return 'noop'

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
export function decidePull(local: LocalMeta, remote: Manifest | null): Decision {
  if (!remote)
    return 'noop'
  if (remote.v > SYNC_SCHEMA_VERSION)
    return 'noop'
  return isRemoteNewer(remote, local) ? 'pull' : 'noop'
}
