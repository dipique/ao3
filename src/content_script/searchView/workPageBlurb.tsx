import type { Work } from '#content_script/blurb.js'

import { fetchWithRetry, PATIENCE } from '#content_script/archiveFetch.js'
import { parseWork } from '#content_script/blurb.js'
import React from '#dom'

/**
 * A listing blurb, built from a work's own page.
 *
 * For a work a list wants but its listing doesn't have — the read list's works
 * are the reader's marks, and a work marked read without being opened is in no
 * AO3 history. Everything a blurb says is on the work page too (rating, tags,
 * byline, summary, stats), so this lays it out in AO3's own blurb markup, and
 * from there it is a work like any other: {@link parseWork} reads it, the view
 * facets and decorates it, and the snapshot stores its HTML.
 *
 * Not a perfect copy. A blurb's `updated_at` is to the second and the work page
 * only gives a day, so it is stamped midnight UTC of that day; and the series a
 * work belongs to is left off, as nothing downstream reads it.
 */

/** What a work page says a rating is called, and the class AO3's symbol sprite draws it with. */
const RATING_CLASSES: Record<string, string> = {
  'General Audiences': 'rating-general-audience',
  'Teen And Up Audiences': 'rating-teen',
  'Mature': 'rating-mature',
  'Explicit': 'rating-explicit',
  'Not Rated': 'rating-notrated',
}

const CATEGORY_CLASSES: Record<string, string> = {
  'F/F': 'category-femslash',
  'M/M': 'category-slash',
  'F/M': 'category-het',
  'Gen': 'category-gen',
  'Multi': 'category-multi',
  'Other': 'category-other',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The `a.tag` links in one of the work page's `dd.<type>.tags` cells. */
function metaTags(meta: Element, type: string): HTMLAnchorElement[] {
  return [...meta.querySelectorAll<HTMLAnchorElement>(`dd.${type}.tags a.tag`)]
}

/** A tag link for the blurb, keeping the work page's own href. */
function tagLink(a: HTMLAnchorElement): HTMLElement {
  return (<a class="tag" href={a.getAttribute('href') ?? ''}>{a.textContent?.trim() ?? ''}</a>) as HTMLElement
}

/** One symbol in the blurb's `ul.required-tags`, in the markup AO3's sprite expects. */
function symbol(className: string, text: string): HTMLElement {
  return (
    <li>
      <a class="help symbol question modal" title="Symbols key" href="/help/symbols_key">
        <span class={className} title={text}><span class="text">{text}</span></span>
      </a>
    </li>
  ) as HTMLElement
}

/** Links joined the way AO3 joins them: ", " between. */
function commaJoined(links: HTMLElement[]): (HTMLElement | string)[] {
  return links.flatMap((link, index) => (index ? [', ', link] : [link]))
}

/** A work page's `2026-02-12` as midnight UTC in epoch seconds, and as a blurb's `12 Feb 2026`. */
function workDate(text: string | undefined): { epoch: number, display: string } | null {
  const match = text?.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match)
    return null
  const [, year, month, day] = match.map(Number) as [number, number, number, number]
  return {
    epoch: Date.UTC(year, month - 1, day) / 1000,
    display: `${day} ${MONTHS[month - 1]} ${year}`,
  }
}

/**
 * Build a listing blurb for `workId` from its work page, or null if `doc` isn't
 * one — a login page, an adult-content gate, a notice that the work is gone.
 */
export function blurbFromWorkPage(doc: Document, workId: string): HTMLLIElement | null {
  const meta = doc.querySelector('dl.work.meta')
  const preface = doc.querySelector('#workskin > .preface.group')
  const titleEl = preface?.querySelector('h2.title.heading')
  if (!meta || !preface || !titleEl)
    return null

  const title = titleEl.textContent?.trim() || '(untitled)'
  const authors = [...preface.querySelectorAll<HTMLAnchorElement>('h3.byline a[rel=author]')]
  const byline = authors.length
    ? commaJoined(authors.map(a => (<a rel="author" href={a.getAttribute('href') ?? ''}>{a.textContent?.trim() ?? ''}</a>) as HTMLElement))
    : [preface.querySelector('h3.byline')?.textContent?.trim() || 'Anonymous']

  const rating = metaTags(meta, 'rating')[0]?.textContent?.trim()
  const warnings = metaTags(meta, 'warning')
  const categories = metaTags(meta, 'category').map(a => a.textContent?.trim() ?? '').filter(Boolean)
  const warningNames = warnings.map(a => a.textContent?.trim() ?? '').filter(Boolean)
  const warningClass = warningNames.includes('No Archive Warnings Apply')
    ? 'warning-no'
    : warningNames.includes('Creator Chose Not To Use Archive Warnings') ? 'warning-choosenotto' : 'warning-yes'

  const stat = (name: string): string => meta.querySelector(`dl.stats dd.${name}`)?.textContent?.trim() ?? ''
  const chapters = stat('chapters')
  const [written, total] = chapters.split('/').map(part => Number.parseInt(part, 10))
  const complete = total !== undefined && !Number.isNaN(total) && written !== undefined && written >= total
  // "Updated:" or "Completed:" when there has been one, else the day it went up.
  const date = workDate(stat('status') || stat('published'))

  const requiredTags = (
    <ul class="required-tags">
      {rating ? symbol(`${RATING_CLASSES[rating] ?? 'rating-notrated'} rating`, rating) : null}
      {warningNames.length ? symbol(`${warningClass} warnings`, warningNames.join(', ')) : null}
      {categories.length
        ? symbol(`${categories.length > 1 ? 'category-multi' : CATEGORY_CLASSES[categories[0]!] ?? 'category-other'} category`, categories.join(', '))
        : null}
      {symbol(complete ? 'complete-yes iswip' : 'complete-no iswip', complete ? 'Complete Work' : 'Work in Progress')}
    </ul>
  )

  const tagItems = [
    ...warnings.map(a => (<li class="warnings"><strong>{tagLink(a)}</strong></li>)),
    ...metaTags(meta, 'relationship').map(a => (<li class="relationships">{tagLink(a)}</li>)),
    ...metaTags(meta, 'character').map(a => (<li class="characters">{tagLink(a)}</li>)),
    ...metaTags(meta, 'freeform').map(a => (<li class="freeforms">{tagLink(a)}</li>)),
  ]

  const summary = preface.querySelector('.summary blockquote.userstuff')
  const summaryEl = (<blockquote class="userstuff summary" />) as HTMLElement
  for (const node of summary?.childNodes ?? [])
    summaryEl.append(document.importNode(node, true))

  const language = meta.querySelector('dd.language')?.textContent?.trim()
  const statRows: (HTMLElement | null)[] = [
    language ? (<dt class="language">Language:</dt>) as HTMLElement : null,
    language ? (<dd class="language">{language}</dd>) as HTMLElement : null,
  ]
  for (const [name, label] of [['words', 'Words'], ['chapters', 'Chapters'], ['comments', 'Comments'], ['kudos', 'Kudos'], ['bookmarks', 'Bookmarks'], ['hits', 'Hits']] as const) {
    const value = stat(name)
    if (value)
      statRows.push((<dt class={name}>{`${label}:`}</dt>) as HTMLElement, (<dd class={name}>{value}</dd>) as HTMLElement)
  }

  const restricted = titleEl.querySelector('img[title="Restricted"]')
  const heading = (
    <h4 class="heading">
      <a href={`/works/${workId}`}>{title}</a>
      {' by '}
      {...byline}
      {restricted ? (<img alt="(Restricted)" title="Restricted" src="/images/lockblue.png" width="15" height="15" />) : null}
    </h4>
  ) as HTMLElement

  const header = (
    <div class="header module">
      {heading}
      <h5 class="fandoms heading">
        <span class="landmark">Fandoms:</span>
        {' '}
        {...commaJoined(metaTags(meta, 'fandom').map(tagLink))}
      </h5>
      {requiredTags}
      {date ? (<p class="datetime">{date.display}</p>) : null}
    </div>
  ) as HTMLElement
  // Where a real blurb keeps the timestamp `parseWork` reads.
  header.prepend(document.createComment(` updated_at=${date?.epoch ?? 0} `))

  return (
    <li id={`work_${workId}`} class="work blurb group" role="article">
      {header}
      <h6 class="landmark heading">Tags</h6>
      <ul class="tags commas">{...tagItems}</ul>
      <h6 class="landmark heading">Summary</h6>
      {summaryEl}
      <dl class="stats">{...statRows}</dl>
    </li>
  ) as HTMLElement as HTMLLIElement
}

/** Build blurbs for works from their own pages. */
export interface WorkBlurbs {
  /** The works built, in the order their ids were asked for. */
  works: Work[]
  /**
   * Works whose own page answered and said no: gone, locked away from this
   * reader, or no work page at all. Nothing further will get them.
   */
  failed: string[]
  /**
   * AO3 was still asking us to wait when patience ran out, so the fetch stopped.
   * The works not reached are neither built nor failed — they were not tried.
   */
  blocked: boolean
}

export interface WorkBlurbOptions {
  signal?: AbortSignal
  /** Called as each work is settled, however it went. */
  onProgress?: (done: number, total: number) => void
  /** See {@link PATIENCE}. Defaults to the interactive one. */
  patience?: number
  /** Max simultaneous requests. Default 3 — polite for AO3. */
  concurrency?: number
}

/**
 * Fetch each work's page and build its blurb, through a small pool and the same
 * shared pacing and rate-limit handling as every other bulk fetch.
 *
 * A work is only `failed` when its own page says so. A refusal stops the lot
 * (`blocked`), and a connection that simply dropped leaves that work unsettled
 * rather than written off — neither is a fact about the work.
 */
export async function fetchWorkBlurbs(ids: readonly string[], opts: WorkBlurbOptions = {}): Promise<WorkBlurbs> {
  const { signal, onProgress, patience = PATIENCE.interactive, concurrency = 3 } = opts
  const built = new Map<string, HTMLLIElement>()
  const failed: string[] = []
  let next = 0
  let done = 0
  let blocked = false

  const settle = (): void => {
    done++
    onProgress?.(done, ids.length)
  }

  const worker = async (): Promise<void> => {
    while (next < ids.length && !blocked) {
      if (signal?.aborted)
        return
      const id = ids[next++]!
      let res: Response
      try {
        // `view_adult` so a Mature or Explicit work shows its page rather than
        // the content warning in front of it.
        res = await fetchWithRetry(`https://archiveofourown.org/works/${id}?view_adult=true`, signal, patience)
      }
      catch {
        if (signal?.aborted)
          return
        settle()
        continue
      }
      if (res.status === 429) {
        blocked = true
        return
      }
      // A server error is the archive's bad moment, not the work's.
      if (res.status >= 500) {
        settle()
        continue
      }
      // A locked work sends a signed-out reader to the login page with a 200.
      const page = res.ok && !/\/users\/login/.test(res.url)
        ? new DOMParser().parseFromString(await res.text(), 'text/html')
        : null
      const blurb = page ? blurbFromWorkPage(page, id) : null
      if (blurb)
        built.set(id, blurb)
      else
        failed.push(id)
      settle()
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker))
  if (signal?.aborted)
    throw new DOMException('Work fetch aborted', 'AbortError')

  const works = ids
    .filter(id => built.has(id))
    .map((id, index) => parseWork(built.get(id)!, index))
  return { works, failed, blocked }
}

/** How a list's source fetches the works its listing didn't have. See `SearchSource.recover`. */
export interface RecoverOptions {
  signal?: AbortSignal
  /**
   * Retry the works an earlier attempt found no page for, too. A reload the
   * reader asked for does; an automatic one leaves them be.
   */
  full: boolean
  onProgress?: (done: number, total: number) => void
  patience?: number
}

/** What a recovery brought back. */
export interface Recovered {
  works: Work[]
  /** AO3 stopped answering before every work was tried. */
  blocked: boolean
}
