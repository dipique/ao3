import type { BuiltinSettings } from '../../common/listLinks.ts'
import type { CachingBuckets } from '../../content_script/siteExport/workText.ts'
import type { BucketBar, BucketFigures } from './buckets.ts'
import type { JobActions, JobView } from './jobView.ts'

import { builtinOpens, hostPage, openLink } from '../../common/listLinks.ts'
import { bucketBar, bucketFigures } from './buckets.ts'
import { listJob } from './jobView.ts'
import { timeAgo } from './moments.ts'
import { moreCounts } from './moreMenu.ts'

/**
 * The reader's own profile lists — Marked for Later and the works they have
 * read — as the tiles under User profile lists: kept and cached like any list,
 * but never reviewed, since nothing new turns up on them that the reader didn't
 * put there. They are named without an account: what the extension keeps
 * belongs to this browser, and the copy shown is the reader's own.
 */

export type ProfileListId = 'marked-for-later' | 'read-works'

export interface ProfileList {
  /** Also the source id its copies are stored under. */
  id: ProfileListId
  name: string
  note: string
  /**
   * With no copy kept and no View on AO3 to keep one, the reader's account
   * not known: the page on AO3 and the switch that keep one.
   */
  empty: string
  /**
   * With no copy kept while the reader's settings leave the list's view
   * nothing to open ({@link builtinOpens}): the setting it needs. A list whose
   * view always opens has none.
   */
  needs?: string
}

/**
 * With no copy kept: how one is, by the tile's own View on AO3, which opens
 * the list's search view and keeps a copy whatever its search switch says.
 */
const KEEP_BY_VIEW = 'None yet. Use View on AO3, signed in, to keep a copy: from then on, it refreshes from here.'

export const PROFILE_LISTS: readonly ProfileList[] = [
  {
    id: 'marked-for-later',
    name: 'Marked for Later',
    note: 'Your own to-read page. Not part of Review — it only changes when you add to it.',
    empty: 'None yet. Open your Marked for Later page on AO3, signed in, with Search your Marked for Later list on: a copy is kept from then on, and refreshes from here.',
  },
  {
    id: 'read-works',
    name: 'Read works',
    note: 'Everything you’ve marked read or given a verdict, Favorites included: a shelf to come back to. Not part of Review — it only changes when you mark something.',
    empty: 'None yet. Press Search read items on your History page on AO3, signed in, with Search the works you\'ve read on: a copy is kept from then on, and refreshes from here.',
    needs: 'None yet. This list is made from your marks, so it needs Work marks on, under Reading.',
  },
]

/** A profile list's offline copy, as its tile reads it. */
export interface ProfileCopy {
  /** Its stored key, which is also what a job names it by. */
  key: string
  count: number
  scrapedAt: number
  buckets: CachingBuckets
  /** Works the list names whose blurbs aren't stored; a refresh brings them back. */
  unstored: number
  /** The page it was read from. */
  listUrl?: string
}

export interface ProfileTileView {
  id: ProfileListId
  name: string
  note: string
  /**
   * Where View on AO3 goes: the list's open URL ({@link openLink}), which opens
   * its search view, on the reader's own page ({@link hostPage}), else, with
   * their account not known, on the page the copy was read from; null with
   * neither, and while the reader's settings leave the view nothing to open
   * ({@link builtinOpens}).
   */
  view: string | null
  /** With no copy: how one is kept, or the setting the list needs before one can be. */
  empty: string | null
  /** "240", and "works · as of 3 hours ago". */
  figure: { count: string, detail: string } | null
  bar: BucketBar | null
  figures: BucketFigures | null
  /**
   * Refresh list, Cache works and Download Offline Copy; Stop while its job
   * runs; Continue or Discard while its job is stopped; nothing with no copy,
   * which has no page to fetch from yet.
   */
  actions: JobActions | null
  /** Why the offline actions are off: another list's job. */
  offlineOff: string | null
  /** The job is on this list, so its line goes in the tile. */
  job: boolean
  /** The works a retry asks for again, stale ones included; with none, More offers no retry. */
  retry: number
  /** The cached works; with none, More offers no download without refreshing, which would hand over an empty site. */
  cached: number
}

export interface ProfileTilesInput {
  /** Each list's copy: the reader's own, as the join chose it. */
  copies: Readonly<Record<ProfileListId, ProfileCopy | null>>
  /** The reader's AO3 account, when the extension has seen it. */
  userId?: string
  /** The reader's settings that decide whether each list's view opens. */
  settings: BuiltinSettings
  job: JobView
  now: number
}

export function profileTiles({ copies, userId, settings, job, now }: ProfileTilesInput): ProfileTileView[] {
  return PROFILE_LISTS.map((list) => {
    const copy = copies[list.id]
    const ref = { kind: list.id }
    const opens = builtinOpens(list.id, settings)
    const page = opens ? hostPage(ref, null, userId) ?? copy?.listUrl : undefined
    const base = { id: list.id, name: list.name, note: list.note, view: page ? openLink(ref, page) : null }
    if (!copy) {
      const empty = !opens && list.needs ? list.needs : base.view ? KEEP_BY_VIEW : list.empty
      return { ...base, empty, figure: null, bar: null, figures: null, actions: null, offlineOff: null, job: false, retry: 0, cached: 0 }
    }

    const { actions, off, here } = listJob(job, copy.key)
    const detail = [`${copy.count === 1 ? 'work' : 'works'} · as of ${timeAgo(copy.scrapedAt, now)}`]
    if (copy.unstored)
      detail.push(`${copy.unstored.toLocaleString()} need refreshing`)
    return {
      ...base,
      empty: null,
      figure: { count: copy.count.toLocaleString(), detail: detail.join(' · ') },
      bar: bucketBar(copy.buckets),
      figures: bucketFigures(copy.buckets),
      actions,
      offlineOff: off,
      job: here,
      ...moreCounts(copy.buckets),
    }
  })
}
