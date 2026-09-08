/**
 * The work-text cache's decidable half: what a cached work *is*, when a cached
 * copy has gone stale, and which works a caching run should therefore fetch.
 *
 * Pure — no `#common`, no `browser`, no DOM, no imports at all — so it loads
 * under a plain `node --test` (see `test/siteExport/staleness.test.mjs`), which
 * is the only way the proxy ladder below gets exercised at every rung. The I/O
 * halves live next door: {@link file://./workTextCache.ts} stores entries,
 * {@link file://./fetchWorkText.ts} fetches and sanitizes them.
 */

/**
 * Sanitizer/schema version. **Bump it whenever
 * {@link file://./sanitize.ts}'s output changes shape** — every entry written
 * by an older sanitizer is then stale by definition ({@link needsFetch}), which
 * is the only thing standing between a sanitizer fix and a cache full of work
 * text nothing knows how to render any more.
 */
export const WORK_TEXT_VERSION = 1

/**
 * The floor under {@link needsFetch}: a copy this old is refetched even when
 * every blurb proxy says nothing changed. Not a fallback but a floor — the
 * proxies catch changes early, and this catches whatever they missed (a blurb
 * that reports `updated_at=0`, an edit that moved neither counter, an AO3
 * change we never anticipated).
 */
export const WORK_TEXT_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** First retry of a failed fetch, doubling per consecutive failure. */
export const FAILURE_BACKOFF_BASE_MS = 60 * 60 * 1000

/** Ceiling on that doubling, so a deleted work is retried yearly, not never. */
export const FAILURE_BACKOFF_MAX_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Why a work's text couldn't be fetched. Recorded on the entry and carried into
 * the export manifest, so the site can say *"not cached — restricted"* rather
 * than serving a link that 404s.
 */
export type WorkTextFailure = 'restricted' | 'notfound' | 'error'

/**
 * Everything about a cached work except the text itself.
 *
 * Split from the HTML deliberately: the whole index is one small
 * `storage.local` read, so planning a run ({@link planWorkCache}) and totalling
 * the cache for the options row cost nothing, while the megabytes stay in
 * per-work keys nobody touches until they're wanted.
 */
export interface WorkTextMeta {
  /** Bytes of sanitized HTML, so a row can total the cache without decoding it. */
  size: number
  /** The blurb's `updated_at` when the text was fetched — the primary staleness proxy. */
  updatedAt: number
  /** Chapters written per the blurb at fetch time — the secondary proxy. */
  chapters: number
  /** Word count per the blurb at fetch time — the tertiary proxy. */
  words: number
  /** Epoch ms the *text* was written (TTL clock + display). Untouched by a later failure. */
  fetchedAt: number
  /** {@link WORK_TEXT_VERSION} at the time of writing. */
  v: number
  /** Set when the last attempt failed; the text (if any) is the previous good copy. */
  failure?: WorkTextFailure
  /** Consecutive failures, for {@link failureBackoffMs}. */
  attempts?: number
  /**
   * Epoch ms of the last *attempt*, successful or not — the backoff clock.
   * Separate from {@link fetchedAt} so a work that starts failing keeps an
   * honest age for the text still cached under it.
   */
  attemptedAt?: number
}

/** A cached work: its metadata plus the sanitized text itself. */
export interface CachedWork extends WorkTextMeta {
  /** Sanitized HTML — the work-meta `<dl>` plus `#workskin` (see {@link file://./sanitize.ts}). */
  html: string
}

/** Every cached work's metadata, keyed by work id. One `storage.local` value. */
export interface WorkTextIndex {
  [workId: string]: WorkTextMeta
}

/**
 * The blurb facts a cached copy is judged against. All four come from a freshly
 * refreshed listing at zero extra requests, which is why an accurate "Update
 * cache" refreshes the list first.
 */
export interface WorkFreshness {
  workId: string
  /** Epoch *seconds* from the blurb's `<!-- updated_at=N -->` comment, or 0. */
  dateUpdated: number
  /** Chapters written (the left number of the blurb's `dd.chapters`). */
  chapters: number
  words: number
}

/** Why a work is being fetched. `null` from {@link needsFetch} means "leave it alone". */
export type FetchReason = 'absent' | 'version' | 'retry' | 'updated' | 'chapters' | 'words' | 'ttl'

export interface FreshnessOptions {
  /** Override the TTL floor (tests, and a future "refetch everything older than…"). */
  ttlMs?: number
  /** Version to consider current; defaults to {@link WORK_TEXT_VERSION}. */
  version?: number
  /**
   * Retry entries carrying a {@link WorkTextMeta.failure} once their backoff has
   * elapsed. On by default; a run that only wants the works it has never had can
   * turn it off. `'now'` ignores the backoff entirely — what the options row's
   * explicit "retry failed" does, since a reader who just signed back into AO3
   * shouldn't have to wait out an hour they can see no reason for.
   */
  retryFailures?: boolean | 'now'
}

/** How long to wait after `attempts` consecutive failures before trying again. */
export function failureBackoffMs(attempts: number | undefined): number {
  const n = Math.max(1, Math.floor(attempts ?? 1) || 1)
  return Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (n - 1))
}

/**
 * Should this work's text be (re)fetched, and why — the ladder of proxies for
 * "has this changed?", cheapest first, `null` when the cached copy still stands.
 *
 * Two choices in the ladder depart from the obvious reading, both deliberate:
 *
 * - **The chapter and word checks are unconditional**, not just a fallback for
 *   `updated_at=0`. Both sides of the comparison come from a blurb, so they're
 *   like for like, and an author who edits without moving `updated_at` is
 *   exactly the case the ladder exists for.
 * - **They compare inequality, not growth.** A deleted chapter and a trimmed
 *   scene are edits too; only the timestamp is one-directional (AO3 hands out a
 *   `0` often enough that a *smaller* one has to mean "no answer", not "older").
 */
export function needsFetch(
  entry: WorkTextMeta | undefined,
  blurb: WorkFreshness,
  now: number,
  opts: FreshnessOptions = {},
): FetchReason | null {
  const { ttlMs = WORK_TEXT_TTL_MS, version = WORK_TEXT_VERSION, retryFailures = true } = opts

  if (!entry)
    return 'absent'

  // A sanitizer bump invalidates unconditionally: whatever is stored was made by
  // a sanitizer this build no longer agrees with.
  if (entry.v !== version)
    return 'version'

  // A failed entry is never judged on the blurb — there may be no text at all to
  // judge. It's retried when its backoff is up, and left alone until then so a
  // run doesn't spend itself on the same deleted works every time.
  if (entry.failure) {
    if (!retryFailures)
      return null
    if (retryFailures === 'now')
      return 'retry'
    const since = now - (entry.attemptedAt ?? entry.fetchedAt)
    return since >= failureBackoffMs(entry.attempts) ? 'retry' : null
  }

  if (blurb.dateUpdated > 0 && entry.updatedAt > 0 && blurb.dateUpdated > entry.updatedAt)
    return 'updated'

  if (blurb.chapters > 0 && blurb.chapters !== entry.chapters)
    return 'chapters'

  if (blurb.words > 0 && blurb.words !== entry.words)
    return 'words'

  if (now - entry.fetchedAt >= ttlMs)
    return 'ttl'

  return null
}

/**
 * Read the staleness proxies off a parsed blurb. Structural rather than typed
 * against `Work` ({@link file://../blurb.ts}) on purpose — importing it would
 * drag `#common` in and cost this module its headless tests.
 */
export function freshnessFromWork(work: {
  workId: string
  dateUpdated: number
  chapters: { written: number }
  words: number
}): WorkFreshness {
  return {
    workId: work.workId,
    dateUpdated: work.dateUpdated,
    chapters: work.chapters.written,
    words: work.words,
  }
}

export interface WorkCachePlan {
  /** Work ids to fetch, in list order — the job runner's queue. */
  queue: string[]
  /** Why each queued work is in the queue. */
  reasons: { [workId: string]: FetchReason }
  /** Cached, current, nothing to do. */
  fresh: string[]
  /** Failed recently enough that we're still waiting out the backoff. */
  waiting: string[]
}

/**
 * Split a refreshed listing into what a caching run has to fetch and what it can
 * leave alone. Order is the listing's own, so a run stopped half way has read
 * the top of the list — which is the part a reader is most likely to want.
 *
 * Works with no id (a blurb that failed to parse) are dropped, and a work listed
 * twice is queued once.
 */
export function planWorkCache(
  works: WorkFreshness[],
  index: WorkTextIndex,
  now: number,
  opts: FreshnessOptions = {},
): WorkCachePlan {
  const plan: WorkCachePlan = { queue: [], reasons: {}, fresh: [], waiting: [] }
  const seen = new Set<string>()

  for (const work of works) {
    if (!work.workId || seen.has(work.workId))
      continue
    seen.add(work.workId)

    const entry = index[work.workId]
    const reason = needsFetch(entry, work, now, opts)
    if (reason) {
      plan.queue.push(work.workId)
      plan.reasons[work.workId] = reason
    }
    else if (entry?.failure) {
      plan.waiting.push(work.workId)
    }
    else {
      plan.fresh.push(work.workId)
    }
  }

  return plan
}

export interface WorkTextUsage {
  /** Entries holding text. */
  cached: number
  /** Entries whose last attempt failed (they may still hold an older copy). */
  failed: number
  /** Total bytes of sanitized HTML. */
  bytes: number
}

/** Total an index for the options row's read-out, without decoding any text. */
export function summarizeWorkText(index: WorkTextIndex): WorkTextUsage {
  const usage: WorkTextUsage = { cached: 0, failed: 0, bytes: 0 }
  for (const meta of Object.values(index)) {
    if (meta.size > 0) {
      usage.cached++
      usage.bytes += meta.size
    }
    if (meta.failure)
      usage.failed++
  }
  return usage
}

/** What discarding orphans would take: which works, and what they come to. */
export interface OrphanPlan {
  /** Index entries no stored list accounts for. Includes ones holding no text. */
  workIds: string[]
  /** Those entries totalled, the same way the whole cache is. */
  usage: WorkTextUsage
}

/**
 * Which cached works no stored list holds any more.
 *
 * The cache is keyed by work and the lists are keyed by list, deliberately — one
 * work can sit in several lists, and its text is hours of requests where the
 * blurbs are one scrape. What that costs is this: forgetting a list leaves its
 * work text behind with nothing pointing at it, and nothing ever tidies up,
 * because the only other way out is deleting every cached work at once. So this
 * is the difference between the two sets, and it is the whole of the decision.
 *
 * `listed` is every work id any stored list holds. An entry with no text is an
 * orphan too: a record of a work that failed to fetch, for a list nobody kept,
 * is dead weight in a value that is read on every options load.
 */
export function planOrphanDiscard(index: WorkTextIndex, listed: ReadonlySet<string>): OrphanPlan {
  const orphaned: WorkTextIndex = {}
  for (const [workId, meta] of Object.entries(index)) {
    if (!listed.has(workId))
      orphaned[workId] = meta
  }
  return { workIds: Object.keys(orphaned), usage: summarizeWorkText(orphaned) }
}
