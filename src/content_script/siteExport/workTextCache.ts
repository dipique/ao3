import type { CachedWork, WorkTextFailure, WorkTextIndex, WorkTextMeta, WorkTextUsage } from './workText.ts'

import { summarizeWorkText, WORK_TEXT_VERSION } from './workText.ts'

/**
 * Where cached work text lives: `browser.storage.local`, one key per work, plus
 * a single small index of everything about those works *except* the text.
 *
 *     workText.79362971   ->  { html: '<div class="ao3e-work">…' }
 *     workTextIndex       ->  { '79362971': { size, updatedAt, chapters, … } }
 *
 * **Why two shapes, and why not `cache.workText`.** The plan sketched one map
 * keyed by work id; a map is one storage value, so caching the four-hundredth
 * work of a list would rewrite the megabytes of the first three hundred and
 * ninety-nine. A key per work fixes the writes but not the reads — planning a
 * run needs `updatedAt`/`chapters`/`words` for every work and none of their
 * text, and the options row wants a byte total. Hence the split: the index
 * answers both in one small read, and the text is only ever fetched by the work
 * that wants it (or by the exporter, one batch at a time).
 *
 * The keys sit outside the `cache.` prefix on purpose. Work text is an order of
 * magnitude larger than everything else in `storage.local` put together, and
 * "Export cache only" ({@link file://../../options_ui/components/option_rows/OptionRowImportExport.vue})
 * should not quietly hand someone a twenty-megabyte JSON file of other people's
 * fic. `workText.` is a prefix a scan — or an exporter's exclusion list — can
 * name exactly.
 *
 * `unlimitedStorage` is already granted, and Chrome backs `storage.local` with
 * IndexedDB anyway; if this layout still turns out to thrash, the fallback is a
 * dedicated IndexedDB store behind these same functions.
 */

/** Prefix for the per-work text blobs. Nothing else may use it. */
const TEXT_PREFIX = 'workText.'

/** The one key holding every work's metadata ({@link WorkTextIndex}). */
const INDEX_KEY = 'workTextIndex'

/** What a per-work key holds. Just the text — everything else is in the index. */
interface StoredText {
  html: string
}

const textKey = (workId: string): string => `${TEXT_PREFIX}${workId}`

/**
 * Serializes index read-modify-writes. A caching run fetches several works at a
 * time and each completion rewrites the index; without this, two overlapping
 * writes would each read the same index and the later one would drop the
 * other's entry.
 */
let writeChain: Promise<unknown> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  // Keep the chain alive after a rejection; the caller still sees the failure.
  writeChain = run.then(() => undefined, () => undefined)
  return run
}

/** Every cached work's metadata. Cheap — one storage value, no text. */
export async function readWorkTextIndex(): Promise<WorkTextIndex> {
  const stored = (await browser.storage.local.get(INDEX_KEY))[INDEX_KEY] as WorkTextIndex | undefined
  return stored ?? {}
}

/** What the options row shows: how many works are cached, and how many bytes. */
export async function workTextUsage(): Promise<WorkTextUsage> {
  return summarizeWorkText(await readWorkTextIndex())
}

/** One work's sanitized text, or null when it isn't cached. */
export async function readWorkText(workId: string): Promise<string | null> {
  const key = textKey(workId)
  const stored = (await browser.storage.local.get(key))[key] as StoredText | undefined
  return stored?.html ?? null
}

/**
 * Several works' text in one read — what the exporter walks the list with.
 * Missing works are simply absent from the result.
 */
export async function readWorkTexts(workIds: string[]): Promise<{ [workId: string]: string }> {
  if (!workIds.length)
    return {}
  const stored = await browser.storage.local.get(workIds.map(textKey))
  const out: { [workId: string]: string } = {}
  for (const workId of workIds) {
    const entry = stored[textKey(workId)] as StoredText | undefined
    if (entry?.html)
      out[workId] = entry.html
  }
  return out
}

/** A cached work whole — metadata and text together. Null when there's no text. */
export async function readCachedWork(workId: string): Promise<CachedWork | null> {
  const [index, html] = await Promise.all([readWorkTextIndex(), readWorkText(workId)])
  const meta = index[workId]
  if (!meta || html === null)
    return null
  return { ...meta, html }
}

/** The proxies to record alongside a freshly fetched work (see {@link WorkTextMeta}). */
export interface WorkTextFacts {
  /** The blurb's `updated_at` — epoch seconds, or 0 when the blurb gave none. */
  updatedAt: number
  /** Chapters written, per the blurb. */
  chapters: number
  /** Word count, per the blurb. */
  words: number
}

/**
 * Store one work's sanitized text and the blurb facts it was current against,
 * clearing any earlier failure. Text and index go in a single `set`, so a
 * half-written pair can't outlive the call.
 */
export async function writeWorkText(workId: string, html: string, facts: WorkTextFacts): Promise<WorkTextMeta> {
  const now = Date.now()
  const meta: WorkTextMeta = {
    size: new TextEncoder().encode(html).length,
    updatedAt: facts.updatedAt,
    chapters: facts.chapters,
    words: facts.words,
    fetchedAt: now,
    attemptedAt: now,
    v: WORK_TEXT_VERSION,
  }
  await serialized(async () => {
    const index = await readWorkTextIndex()
    index[workId] = meta
    await browser.storage.local.set({
      [textKey(workId)]: { html } satisfies StoredText,
      [INDEX_KEY]: index,
    })
  })
  return meta
}

/**
 * Record that a work couldn't be fetched, and why.
 *
 * Any text already stored for it is **kept**: a work that went restricted, or a
 * request that timed out, is no reason to throw away the copy that was read
 * happily yesterday. The entry's `fetchedAt` therefore keeps describing that
 * text, while `attemptedAt`/`attempts` drive the retry backoff.
 */
export async function recordWorkTextFailure(workId: string, failure: WorkTextFailure): Promise<WorkTextMeta> {
  return serialized(async () => {
    const index = await readWorkTextIndex()
    const previous = index[workId]
    const meta: WorkTextMeta = {
      size: previous?.size ?? 0,
      updatedAt: previous?.updatedAt ?? 0,
      chapters: previous?.chapters ?? 0,
      words: previous?.words ?? 0,
      fetchedAt: previous?.fetchedAt ?? 0,
      v: previous?.v ?? WORK_TEXT_VERSION,
      failure,
      attempts: (previous?.attempts ?? 0) + 1,
      attemptedAt: Date.now(),
    }
    index[workId] = meta
    await browser.storage.local.set({ [INDEX_KEY]: index })
    return meta
  })
}

/** Forget the given works entirely — text and index entry both. */
export async function removeWorkTexts(workIds: string[]): Promise<void> {
  if (!workIds.length)
    return
  await serialized(async () => {
    const index = await readWorkTextIndex()
    for (const workId of workIds)
      delete index[workId]
    await browser.storage.local.remove(workIds.map(textKey))
    await browser.storage.local.set({ [INDEX_KEY]: index })
  })
}

/**
 * Drop every cached work text — the options page's "Purge cached work text".
 *
 * Sweeps by *key*, not by index, so text left behind by an interrupted write (or
 * by an index that was cleared on its own) goes too. `getKeys` is the cheap way
 * and exists in neither browser's minimum supported version, so the fallback
 * reads the store — which is exactly the read this whole layout exists to avoid,
 * and is why it only happens on an explicit purge.
 */
export async function purgeWorkText(): Promise<WorkTextUsage> {
  return serialized(async () => {
    const usage = summarizeWorkText(await readWorkTextIndex())
    const keys = (await allStorageKeys()).filter(key => key.startsWith(TEXT_PREFIX))
    await browser.storage.local.remove([...keys, INDEX_KEY])
    return usage
  })
}

async function allStorageKeys(): Promise<string[]> {
  const area = browser.storage.local as typeof browser.storage.local & { getKeys?: () => Promise<string[]> }
  if (typeof area.getKeys === 'function')
    return await area.getKeys()
  return Object.keys(await browser.storage.local.get(null))
}
