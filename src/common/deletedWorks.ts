/**
 * Works AO3 has deleted, kept on the lists that held them.
 *
 * A read of a listing used to store the listing as it now stands, so a work AO3
 * had deleted simply dropped off the copy, and its blurb and cached text became
 * orphans. A deleted work stays on its list instead, recorded as deleted (when it
 * was noticed, and the history entry that stood for it), and the view draws it
 * with a "Deleted" badge.
 *
 * **How a deletion is noticed.** A readings page (Marked for Later, History)
 * keeps a "Deleted work" entry in the place of each deleted work it held. The
 * entry names no work: only AO3's id for the history entry (`/readings/<id>`)
 * and the day the work was last visited. A list keeps each work's readings block
 * with that history entry id on it (`data-reading`, put there as the block is
 * split off), so an entry is matched to the work by it. A block kept before the
 * id was, has the day alone; the entry is then matched to the one held work that
 * left the listing and was last visited that day, and to none when that would be
 * a guess.
 *
 * **What a read keeps.** A listing that shows an entry for every deleted work it
 * holds keeps a deleted work while its entry is there: the reader taking the
 * entry off their history takes the work off the list. Any other listing has no
 * entries, deleted works just vanish from it, so a work already known deleted is
 * kept where it stood.
 *
 * Pure, so it loads under a plain `node --test`.
 */

/** What a readings page's "Deleted work" entry says. */
export interface DeletedEntry {
  /** AO3's id for the history entry, from its "Delete from History" form. */
  readingId: string | null
  /** The day the work was last visited, as AO3 writes it ("16 Sep 2026"). */
  visited: string | null
}

/** A "Deleted work" entry where it stood: after the listing's work `after`, or first. */
export interface ListedEntry {
  after: string | null
  entry: DeletedEntry
}

/** What a stored copy says about one of its works' readings block. */
export interface HeldWork {
  id: string
  readingId: string | null
  visited: string | null
}

/** A work recorded as deleted. */
export interface DeletedWork {
  /** Epoch ms it was first noticed. */
  at: number
  /** The history entry standing for it on a readings page, once known. */
  reading?: string
}

export interface DeletedPlanInput {
  /**
   * The work ids the read will store, in order: what it found, and whatever it
   * carried from the stored copy (works it never reached).
   */
  order: readonly string[]
  /** The work ids the listing itself showed: only these are found back on AO3. */
  seen: readonly string[]
  /** The listing's "Deleted work" entries, in listing order. */
  entries: readonly ListedEntry[]
  /** The works the copy held before the read, in its order. */
  held: readonly HeldWork[]
  /** Every work recorded as deleted, by work id. */
  known: { readonly [id: string]: DeletedWork }
  /** The listing shows an entry for every deleted work it holds ({@link isReadingsListing}). */
  entriesShown: boolean
  now: number
}

export interface DeletedPlan {
  /** The ids to store, in order: the read's, with the deleted works it keeps put back. */
  order: string[]
  /** Every work in {@link order} recorded as deleted, with its record as it now stands. */
  deleted: { [id: string]: DeletedWork }
  /** Records to write: works newly noticed, or whose history entry id was learned. */
  noticed: { [id: string]: DeletedWork }
  /** Works recorded as deleted that the listing showed: back on AO3. */
  revived: string[]
}

/** "Last visited: 16 Sep 2026" on a work, "last visited 16 Sep 2026" on a deleted one; tags between. */
const VISITED_RE = /last visited:?\s*(?:<[^>]*>\s*)*(\d{1,2} [a-z]{3} \d{4})/i
const ENTRY_READING_RE = /\/readings\/(\d+)|name="reading"[^>]*?value="(\d+)"/
const KEPT_READING_RE = /data-reading="(\d+)"/

/** The facts of a "Deleted work" entry, from its markup. */
export function deletedEntryFacts(html: string): DeletedEntry {
  const reading = html.match(ENTRY_READING_RE)
  return {
    readingId: reading?.[1] ?? reading?.[2] ?? null,
    visited: html.match(VISITED_RE)?.[1] ?? null,
  }
}

/**
 * The facts of a work's readings block: the one a list keeps, or one still on a
 * blurb as a readings page served it, form and all.
 */
export function readingFacts(html: string | undefined): { readingId: string | null, visited: string | null } {
  if (!html)
    return { readingId: null, visited: null }
  const served = html.match(ENTRY_READING_RE)
  return {
    readingId: html.match(KEPT_READING_RE)?.[1] ?? served?.[1] ?? served?.[2] ?? null,
    visited: html.match(VISITED_RE)?.[1] ?? null,
  }
}

/** Whether a listing is a readings page, which shows an entry for every deleted work it holds. */
export function isReadingsListing(url: string): boolean {
  return /\/users\/[^/?#]+\/readings(?:[?#]|$)/.test(url)
}

/**
 * The list a read stores, with the deleted works it keeps, and what to record
 * about them. See this module's notes for the rules.
 */
export function planDeleted(input: DeletedPlanInput): DeletedPlan {
  const { order, entries, held, known, entriesShown, now } = input
  const listed = new Set(order)
  const seen = new Set(input.seen)
  const readingOf = (work: HeldWork): string | null => known[work.id]?.reading ?? work.readingId
  const candidates = held.filter(work => !listed.has(work.id))
  const matched = new Map<number, string>()
  const taken = new Set<string>()

  entries.forEach(({ entry }, index) => {
    if (!entry.readingId)
      return
    const work = candidates.find(work => !taken.has(work.id) && readingOf(work) === entry.readingId)
    if (work) {
      matched.set(index, work.id)
      taken.add(work.id)
    }
  })

  // By day only among works with no history entry id of their own, and only
  // when there are no more of them than entries for that day: one entry and two
  // works would be a guess.
  const byDay = new Map<string, number[]>()
  entries.forEach(({ entry }, index) => {
    if (!matched.has(index) && entry.visited)
      byDay.set(entry.visited, [...byDay.get(entry.visited) ?? [], index])
  })
  for (const [day, indices] of byDay) {
    const pool = candidates.filter(work => !taken.has(work.id) && !readingOf(work) && work.visited === day)
    if (!pool.length || pool.length > indices.length)
      continue
    pool.forEach((work, k) => {
      matched.set(indices[k]!, work.id)
      taken.add(work.id)
    })
  }

  const deleted: DeletedPlan['deleted'] = {}
  const noticed: DeletedPlan['noticed'] = {}
  const inserts = new Map<string | null, string[]>()
  const tail: string[] = []
  const insert = (after: string | null, id: string): void => {
    if (after !== null && !listed.has(after))
      tail.push(id)
    else
      inserts.set(after, [...inserts.get(after) ?? [], id])
  }

  entries.forEach(({ after, entry }, index) => {
    const id = matched.get(index)
    if (id === undefined)
      return
    const was = known[id]
    const reading = entry.readingId ?? was?.reading
    const record: DeletedWork = { at: was?.at ?? now, ...(reading ? { reading } : {}) }
    deleted[id] = record
    if (!was || record.reading !== was.reading)
      noticed[id] = record
    insert(after, id)
  })

  if (!entriesShown) {
    held.forEach((work, index) => {
      if (listed.has(work.id) || taken.has(work.id) || !known[work.id])
        return
      let after: string | null = null
      for (let i = index - 1; i >= 0; i--) {
        if (listed.has(held[i]!.id)) {
          after = held[i]!.id
          break
        }
      }
      deleted[work.id] = known[work.id]!
      insert(after, work.id)
    })
  }

  // Carried from the stored copy, not found: still what it was.
  for (const id of order) {
    if (known[id] && !seen.has(id))
      deleted[id] = known[id]!
  }

  const out = [...inserts.get(null) ?? []]
  for (const id of order)
    out.push(id, ...inserts.get(id) ?? [])
  out.push(...tail)

  return {
    order: out,
    deleted,
    noticed,
    revived: Object.keys(known).filter(id => seen.has(id)),
  }
}
