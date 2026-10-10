import type { Options } from './options.ts'
import type { DecodeResult, Manifest, Upload } from './syncCodec.ts'

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
 * it or taken from it: there is nothing whole to back up first, or to apply.
 * Past {@link SYNC_CONSISTENCY_WAIT_MS} from when this browser first read that
 * upload so, no browser is taken to be sending the rest any more, and the
 * copy can be replaced with this browser's settings.
 */

/**
 * What a read of the synced store found: a copy at this sync version, `whole`
 * or `partial`, the latter with the upload its manifest names, or `none`: no
 * copy, or one at another version, which isn't read whole at all (an older one
 * is never taken, a newer one pauses sync).
 */
export type CopyFound = { read: 'whole' | 'none' } | { read: 'partial', upload: Upload }

/** A read that found no whole copy. */
type Unread = Exclude<CopyFound, { read: 'whole' }>

/** What a read that decoded to `result` found, `manifest` being the manifest it read. */
export function foundOf(result: DecodeResult, manifest: Pick<Manifest, 'g' | 'w'> | undefined): CopyFound {
  return result.ok ? { read: 'whole' } : unreadOf(result.reason, manifest)
}

function unreadOf(reason: Extract<DecodeResult, { ok: false }>['reason'], manifest: Pick<Manifest, 'g' | 'w'> | undefined): Unread {
  if ((reason === 'incomplete' || reason === 'corrupt') && manifest)
    return { read: 'partial', upload: { g: manifest.g, w: manifest.w } }
  return { read: 'none' }
}

export type CopyCheck = { read: 'whole', options: Partial<Options> } | Unread

/** Reads the synced store's `items` as a build at sync version `version` does. */
export async function checkCopy(items: Record<string, unknown>, version = SYNC_SCHEMA_VERSION): Promise<CopyCheck> {
  const manifest = items[MANIFEST_KEY] as Manifest | undefined
  if (manifest && typeof manifest === 'object' && manifest.v !== version)
    return { read: 'none' }
  const result = await decode(items, version)
  return result.ok ? { read: 'whole', options: result.options } : unreadOf(result.reason, manifest)
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
  /** When this browser first read {@link upload} so. */
  since: number
  /** Still so past the wait: no other browser is taken to be sending the rest. */
  overdue: boolean
  /** Past the wait, and this browser's own settings can replace it ({@link ownCopyReplaces}). */
  replaceable: boolean
  /** The upload whose manifest it was read under. A record a build from before it kept has none. */
  upload?: Upload
}

/**
 * The record after a read that found `found`, at `now`. `ownReplaces` is
 * whether this browser's own settings can replace the copy. A whole copy, or
 * none at this version, ends it. A partial one keeps when its upload was first
 * read so, however often it is read again, and another upload's starts a wait
 * of its own: its sender may still be sending it.
 */
export function nextInconsistency(record: Inconsistency | null, found: CopyFound, now: number, ownReplaces: boolean): Inconsistency | null {
  if (found.read !== 'partial')
    return null
  const { upload } = found
  const same = !!record?.upload && record.upload.g === upload.g && record.upload.w === upload.w
  const since = same ? record.since : now
  const overdue = now - since >= SYNC_CONSISTENCY_WAIT_MS
  return { since, overdue, replaceable: overdue && ownReplaces, upload }
}

/** Milliseconds from `now` until the wait is up, when the copy is read again; null with nothing to wait for. */
export function recheckIn(record: Inconsistency | null, now: number): number | null {
  if (!record || record.overdue)
    return null
  return Math.max(0, record.since + SYNC_CONSISTENCY_WAIT_MS - now)
}

/**
 * Why an answer to what sync asks is refused over a copy that can't be read
 * whole: within the wait another browser is still `sending` it; past it, it is
 * `inconsistent`.
 */
export type AnswerRefusal = 'sending' | 'inconsistent'

export function answerRefusal(record: Inconsistency): AnswerRefusal {
  return record.overdue ? 'inconsistent' : 'sending'
}
