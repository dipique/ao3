import type { Options } from './options.ts'
import type { DecodeResult, Manifest } from './syncCodec.ts'

import { SYNC_CONSISTENCY_WAIT_MS } from './constants.ts'
import { decode, encode, MANIFEST_KEY, pruneToSynced, SYNC_SCHEMA_VERSION } from './syncCodec.ts'

/**
 * Whether the synced copy can be read whole, and how long one that can't has
 * been waited on. Pure, so the sync tests reach it under plain Node.
 *
 * The sync services don't promise that the parts of one upload arrive
 * together, so a browser can read a manifest whose parts aren't all there
 * yet, or a part another upload left behind. While it can't be read whole,
 * another browser is taken to be still sending it, and nothing is written over
 * it: there is nothing whole to back up first. Past {@link SYNC_CONSISTENCY_WAIT_MS}
 * no browser is taken to be sending the rest any more, and the copy can be
 * replaced with this browser's settings.
 */

/**
 * What a read of the synced store found: a copy at this sync version, `whole`
 * or `partial`, or `none`: no copy, or one at another version, which isn't
 * read whole at all (an older one is never taken, a newer one pauses sync).
 */
export type CopyRead = 'whole' | 'partial' | 'none'

export function readOf(result: DecodeResult): CopyRead {
  if (result.ok)
    return 'whole'
  return result.reason === 'incomplete' || result.reason === 'corrupt' ? 'partial' : 'none'
}

export type CopyCheck = { read: 'whole', options: Partial<Options> } | { read: 'partial' | 'none' }

/** Reads the synced store's `items` as a build at sync version `version` does. */
export async function checkCopy(items: Record<string, unknown>, version = SYNC_SCHEMA_VERSION): Promise<CopyCheck> {
  const manifest = items[MANIFEST_KEY] as Manifest | undefined
  if (manifest && typeof manifest === 'object' && manifest.v !== version)
    return { read: 'none' }
  const result = await decode(items, version)
  return result.ok ? { read: 'whole', options: result.options } : { read: readOf(result) as 'partial' | 'none' }
}

/** Whether this browser's settings, written as an upload would write them, pass the same check. */
export async function ownCopyWhole(options: Options, defaults: Options, version = SYNC_SCHEMA_VERSION): Promise<boolean> {
  try {
    const { chunks, manifest } = await encode(options, defaults, 1, 'check', version)
    return (await checkCopy({ ...chunks, [MANIFEST_KEY]: manifest }, version)).read === 'whole'
  }
  catch {
    return false
  }
}

/**
 * Whether this browser's settings can replace a copy that can't be read
 * whole: they hold something beyond defaults, and pass the same check. A
 * replacement holding nothing beyond defaults would ask no other browser
 * anything: each one holding settings of its own sends them over such a copy,
 * all at about once, and whichever lands last reaches the rest as an ordinary
 * update.
 */
export async function ownCopyReplaces(options: Options, defaults: Options, version = SYNC_SCHEMA_VERSION): Promise<boolean> {
  return Object.keys(pruneToSynced(options, defaults)).length > 0 && ownCopyWhole(options, defaults, version)
}

/** A synced copy this browser has read and couldn't read whole, kept device-local as `sync.inconsistent`. */
export interface Inconsistency {
  /** When this browser first read it so. */
  since: number
  /** Still so past the wait: no other browser is taken to be sending the rest. */
  overdue: boolean
  /** Past the wait, and this browser's own settings can replace it ({@link ownCopyReplaces}). */
  replaceable: boolean
}

/**
 * The record after a read that found `read`, at `now`. `ownReplaces` is
 * whether this browser's own settings can replace the copy. A whole copy, or
 * none at this version, ends it; a partial one keeps when it was first read,
 * so the wait runs from then however often it is read again.
 */
export function nextInconsistency(record: Inconsistency | null, read: CopyRead, now: number, ownReplaces: boolean): Inconsistency | null {
  if (read !== 'partial')
    return null
  const since = record?.since ?? now
  const overdue = now - since >= SYNC_CONSISTENCY_WAIT_MS
  return { since, overdue, replaceable: overdue && ownReplaces }
}

/** Milliseconds from `now` until the wait is up, when the copy is read again; null with nothing to wait for. */
export function recheckIn(record: Inconsistency | null, now: number): number | null {
  if (!record || record.overdue)
    return null
  return Math.max(0, record.since + SYNC_CONSISTENCY_WAIT_MS - now)
}

/**
 * Why keeping this browser's settings is refused over a copy that can't be
 * read whole: within the wait another browser is still `sending` it; past it,
 * it is `inconsistent`.
 */
export type KeepRefusal = 'sending' | 'inconsistent'

export function keepRefusal(record: Inconsistency): KeepRefusal {
  return record.overdue ? 'inconsistent' : 'sending'
}
