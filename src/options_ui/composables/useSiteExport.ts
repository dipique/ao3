import type { JoinedSavedList, SnapshotDescriptor, StoredListRef } from '#common'
import type { ChangeImportReport } from '#content_script/siteExport/importChanges.js'
import type { ExportJobPhase, JobStatus } from '#content_script/siteExport/job.js'
import type { CachingBuckets, WorkTextUsage } from '#content_script/siteExport/workText.js'

import { cache, copyOwner, getArchiveLink, joinSavedLists, listCopies, listUrlFor, planRemoveList, planTrackCopy, REVIEW_SOURCE_ID, storedListRefs, toast, utcToday } from '#common'
import { blurbOrphans, discardOrphanedBlurbs } from '#content_script/searchView/blurbStore.js'
import { deleteSnapshot, listSnapshots, snapshotWorkIds } from '#content_script/searchView/cache.js'
import { importChanges as replayChangeFile } from '#content_script/siteExport/importChanges.js'
import { discardJob, jobStatus, loadJob, resumeJob, startJob, stopJob, subscribeJob } from '#content_script/siteExport/job.js'
import { cachingBuckets, planOrphanDiscard, summarizeWorkText } from '#content_script/siteExport/workText.js'
import { discardOrphanedWorkText, purgeWorkText, readWorkTextIndex } from '#content_script/siteExport/workTextCache.js'

import type { ProfileList, ProfileListId } from '../model/profileLists.ts'

import { formatBytes } from '../model/buckets.ts'
import { jobView, offReason } from '../model/jobView.ts'
import { timeAgo } from '../model/moments.ts'
import { PROFILE_LISTS } from '../model/profileLists.ts'
import { REVIEW_NAME } from '../model/review.ts'
import { copyTitle, savedListRows, titlePlaceholder } from '../model/savedListRows.ts'
import { useSavedLists } from './useSavedLists.ts'

/**
 * The options page's view of the site export: every stored list, the saved
 * lists they are the offline copies of, the job runner's live status, the
 * cache read-out underneath, and the way back in for the changes a reader made
 * inside an exported file.
 *
 * Module-level state, like {@link file://./useSync.ts}, because the runner it
 * mirrors is itself a singleton — there is one job for the whole extension, so
 * two components asking for it must see the same one.
 */

/**
 * One stored list: a saved list's offline copy, or a row of its own, under
 * Lists → Saved lists; one of the reader's own profile lists, a tile under
 * Lists → User profile lists; or the review's window, This review under
 * Lists → Review.
 */
export interface SiteExportListRow {
  /** Snapshot key — also what a job names the list by. */
  key: string
  label: string
  /** Absent on a v1 snapshot, which is why such a row can't be refreshed. */
  descriptor?: SnapshotDescriptor
  /** Where the list lives on AO3, for the link beside its name. */
  listUrl?: string
  scrapedAt: number
  /** Works in the list. */
  count: number
  /** Its works in the cache's buckets: cached, failed and new. */
  buckets: CachingBuckets
  /** Works in this list whose text is cached. */
  cached: number
  /** Works in this list whose last fetch failed. */
  failed: number
  /** Works in this list with no cached text at all. */
  uncached: number
  /** Bytes of cached text belonging to this list. */
  bytes: number
  /** Works the list names whose blurbs aren't stored; a refresh brings them back. */
  unstored: number
  /** The read-out under the title, and the row's search haystack. */
  summary: string
}

/**
 * What "Discard orphans" would take, so the row can say so before it is pressed:
 * work text and blurbs both, since both are stored by work and outlive the lists
 * that wanted them.
 *
 * The count is the offer and the confirmation both — a reader who has just
 * deleted a list should be able to see how much that left behind, and a reader
 * whose cache is entirely accounted for should find the button switched off
 * rather than have to press it to learn nothing happens.
 */
export interface OrphanSummary {
  /** Cache entries no stored list holds, including ones with no text under them. */
  works: number
  /** How many of those hold text, and how much of it. */
  cached: number
  bytes: number
  /** Stored blurbs no list holds (past the grace period a fresh write gets), and their markup's size. */
  blurbs: number
  blurbBytes: number
}

const rows = ref<SiteExportListRow[]>([])
const usage = ref<WorkTextUsage>({ cached: 0, failed: 0, bytes: 0 })
const orphans = ref<OrphanSummary>({ works: 0, cached: 0, bytes: 0, blurbs: 0, blurbBytes: 0 })
const loading = ref(true)
const status = shallowRef<JobStatus>(jobStatus())

/**
 * The last change file this page took in, and whether one is being taken in now.
 *
 * Kept beside the rest of the feature's state rather than in the component,
 * because a report is the answer to an action that reached AO3 and the reader's
 * whole mark table — it should survive them scrolling the section shut and open
 * again, the way the job runner's progress does.
 */
const changeReport = shallowRef<ChangeImportReport | null>(null)
const importingChanges = ref(false)

/**
 * The saved lists, read here so a stored list can say which saved list it is,
 * and be tracked from its row. Taken once, like the state above: the refs read
 * through to the options page's own reactive copy, so a list retitled under
 * Saved lists is called by its new title everywhere at once.
 */
const savedLists = useSavedLists()

/** Whether Tracked lists is on, which tracking from a row waits on. */
const reviewing = computed(() => useOption('trackedLists').enabled.value)

/**
 * The reader's AO3 account, which says whose profile lists are theirs. Read
 * through the option afresh each time, since this module runs before the
 * options are loaded, and the extension can learn the account later still.
 */
const userId = computed(() => useOption('user').userId?.value)

/** A stored list as the saved-list join reads it. */
function refOf(row: SiteExportListRow): StoredListRef {
  const { key, descriptor, scrapedAt } = row
  return descriptor ? { key, sourceId: descriptor.sourceId, listUrl: descriptor.listUrl, label: descriptor.label, scrapedAt } : { key, scrapedAt }
}

const joined = computed(() => joinSavedLists(savedLists.current(), rows.value.map(refOf), userId.value))

/**
 * The reader's own profile lists' copies, as the join chose them, each shown
 * as a tile under Lists → User profile lists. Another account's copy, or one
 * no visit has described, stays a row.
 */
const profileRows = computed((): Record<ProfileListId, SiteExportListRow | null> => {
  const { markedForLater, readWorks } = joined.value.builtins
  const rowOf = (ref: StoredListRef | null): SiteExportListRow | null => (ref && rows.value.find(row => row.key === ref.key)) || null
  return { 'marked-for-later': rowOf(markedForLater), 'read-works': rowOf(readWorks) }
})

/** The profile list a stored list is shown as, if it is one. */
function profileListOf(row: SiteExportListRow): ProfileList | null {
  return PROFILE_LISTS.find(list => profileRows.value[list.id]?.key === row.key) ?? null
}

/**
 * Whether this is the review's own stored window, which is stored like a list,
 * and the one that can't be re-read from here. It is This review, under
 * Lists → Review, rather than a row of its own.
 */
export function isReviewWindow(row: SiteExportListRow): boolean {
  return row.descriptor?.sourceId === REVIEW_SOURCE_ID
}

/** The review's stored window, or null before the first review is gathered. */
const review = computed(() => rows.value.find(isReviewWindow) ?? null)

/** A stored list by its key. */
function rowFor(key: string): SiteExportListRow | null {
  return rows.value.find(row => row.key === key) ?? null
}

/**
 * Whether this list can be read from AO3 again from this page.
 *
 * Every other row is one listing, and refreshing it means walking that
 * listing's pages. The review's window is not: it is gathered from every
 * tracked list at once, by date, and the address it carries is the page the
 * review opens on. Refreshing it from here would scrape the reader's readings
 * list over the window and store an answer the next review discards — so the
 * button is off, and opening the review is what brings the window up to date.
 */
export function canRefresh(row: SiteExportListRow): boolean {
  return !!row.descriptor && !isReviewWindow(row)
}

/**
 * The saved list this stored list is, if any ({@link copyOwner}): one at its
 * address, which is the list's own key with its view filter left out, so a list
 * narrowed in its search view still finds the copy of its page, whatever order
 * or sort the page's address was in.
 */
function savedListFor(row: SiteExportListRow): JoinedSavedList | null {
  return row.descriptor ? copyOwner(joined.value, row.descriptor) : null
}

/**
 * A stored list's name, as the place it is shown calls it: the review's, a
 * profile list's tile's, the title of the saved list it is, else what its own
 * row under Saved lists is called ({@link copyTitle}).
 */
function listName(row: SiteExportListRow): string {
  if (isReviewWindow(row))
    return REVIEW_NAME
  const profile = profileListOf(row)
  if (profile)
    return profile.name
  const owner = savedListFor(row)
  if (owner)
    return (typeof owner.list.title === 'string' ? owner.list.title.trim() : '') || titlePlaceholder(owner.list)
  return copyTitle(refOf(row))
}

subscribeJob((next) => {
  status.value = next
})

/**
 * A clock, ticking only while the job sits out a pause, so its countdown goes
 * down. The runner reports when it may next ask AO3 for something rather than
 * how long that is, and a permanent interval would be a poor trade for a line
 * that is usually absent.
 */
const now = ref(Date.now())
watchEffect((onCleanup) => {
  if (!status.value.waitingUntil)
    return
  now.value = Date.now()
  const timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  onCleanup(() => clearInterval(timer))
})

/** A stored list's name by its key, for the job; `''` for one with no row. */
function nameOf(key: string): string {
  const row = rows.value.find(one => one.key === key)
  return row ? listName(row) : ''
}

/** The job as the page shows it ({@link jobView}): every control it turns off, and its own line, read it from here. */
const view = computed(() => jobView(status.value, nameOf, now.value))

/** What a key with no stored list holds. */
const NO_WORKS: CachingBuckets = { total: 0, cached: 0, failed: 0, unfetched: 0, bytes: 0, staleFailures: 0 }

/** The saved lists as the rows under Lists → Saved lists ({@link savedListRows}), in the join's order. */
const savedRows = computed(() => savedListRows(joined.value, {
  copy: (key) => {
    const row = rowFor(key)
    return { buckets: row?.buckets ?? NO_WORKS, unstored: row?.unstored ?? 0 }
  },
  review: reviewing.value,
  jobOff: key => offReason(view.value, key),
}))

/** Re-read the lists and the cache index. Cheap enough to run after every action. */
async function reload(): Promise<void> {
  const [snapshots, index, listed] = await Promise.all([listSnapshots(), readWorkTextIndex(), snapshotWorkIds()])
  usage.value = summarizeWorkText(index)
  // Read from every stored list rather than from `snapshots`, which is filtered
  // to the ones this build can render — see {@link snapshotWorkIds}.
  const stranded = planOrphanDiscard(index, listed)
  const blurbs = await blurbOrphans(listed)
  orphans.value = {
    works: stranded.workIds.length,
    cached: stranded.usage.cached,
    bytes: stranded.usage.bytes,
    blurbs: blurbs.ids.length,
    blurbBytes: blurbs.bytes,
  }
  rows.value = snapshots.map((snapshot) => {
    const buckets = cachingBuckets(snapshot.workIds, index)
    const { cached, failed, staleFailures, bytes } = buckets
    const listUrl = listUrlFor(snapshot.key, snapshot.descriptor)
    const row: SiteExportListRow = {
      key: snapshot.key,
      label: snapshot.descriptor?.label ?? snapshot.key,
      descriptor: snapshot.descriptor,
      listUrl: listUrl && getArchiveLink(listUrl),
      scrapedAt: snapshot.scrapedAt,
      count: snapshot.count,
      buckets,
      cached,
      failed: failed + staleFailures,
      uncached: Math.max(0, snapshot.count - cached),
      bytes,
      unstored: snapshot.unstored,
      summary: '',
    }
    row.summary = summarize(row)
    return row
  })
  loading.value = false
}

function summarize(row: SiteExportListRow): string {
  const parts = [
    `${row.count.toLocaleString()} ${row.count === 1 ? 'work' : 'works'} as of ${timeAgo(row.scrapedAt, Date.now())}`,
    `${(row.cached || 0).toLocaleString()} cached (${formatBytes(row.bytes)})`,
  ]
  if (row.uncached)
    parts.push(`${row.uncached.toLocaleString()} uncached`)
  if (row.failed)
    parts.push(`${row.failed.toLocaleString()} failed`)
  if (row.unstored)
    parts.push(`${row.unstored.toLocaleString()} need refreshing`)
  return parts.join(' · ')
}

/**
 * Forget the stored lists `keys`, in turn, and draw the rows again. A stopped
 * job on one of them goes first: its list would be gone, and with it the row
 * that offers to continue it.
 */
async function forget(keys: readonly string[]): Promise<void> {
  const { key, state } = view.value
  if (state === 'stopped' && key !== null && keys.includes(key))
    await run('discard the job', discardJob)
  for (const one of keys)
    await deleteSnapshot(one)
  if (keys.length)
    await reload()
}

/**
 * Run one job and report it. The runner keeps the interesting failures in its
 * own status (they belong to the row, next to the progress bar); what is caught
 * here is only the refusal to start a second job at once.
 */
async function run(label: string, start: () => Promise<void>): Promise<void> {
  try {
    await start()
  }
  catch (err) {
    toast(err instanceof Error ? err.message : `Could not ${label}.`, { type: 'error' })
  }
  await reload()
}

// Auto-resume: adopt whatever a previous session left unfinished, so opening
// this page after a crash or a browser restart can offer to carry on.
void loadJob().then(reload)

export function useSiteExport() {
  return {
    rows,
    rowFor,
    savedRows,
    profileRows,
    userId,
    review,
    usage,
    orphans,
    loading,
    view,
    reload,
    changeReport,
    importingChanges,

    /** Re-scrape a list, without touching the work text. */
    refreshList(row: SiteExportListRow) {
      if (!canRefresh(row)) {
        toast('This list isn\'t read from one listing, so there is nothing to refresh.', { type: 'error' })
        return
      }
      return startFor(row, ['refreshing'])
    },

    /**
     * Fetch the work text this list is missing, judged against the stored list
     * as it stands. An accurate answer wants a fresh list first — which is
     * why the row says how old this one is, and why "Download site" will refresh
     * before it caches.
     */
    cacheWorks(row: SiteExportListRow, opts: { retryNow?: boolean } = {}) {
      return startFor(row, ['caching'], opts.retryNow)
    },

    /** Refresh the list, then cache against it — the two steps as one job. */
    refreshAndCache(row: SiteExportListRow) {
      if (!canRefresh(row)) {
        toast('This list isn\'t read from one listing, so there is nothing to refresh.', { type: 'error' })
        return
      }
      return startFor(row, ['refreshing', 'caching'])
    },

    /**
     * The one-button path: refresh the list, fetch whatever the cache is
     * missing, then write the zip. Long, and the progress bar says so.
     *
     * A list that can't be re-read from here is exported from the works it
     * already holds — the step is left out rather than the button.
     */
    downloadSite(row: SiteExportListRow) {
      const steps: ExportJobPhase[] = canRefresh(row) ? ['refreshing', 'caching', 'exporting'] : ['caching', 'exporting']
      return startFor(row, steps)
    },

    /**
     * Export exactly what is on disk — no request to AO3 at all. Offered from a
     * menu rather than as a checkbox, so the item itself says which of the two
     * things is about to happen.
     */
    downloadCached(row: SiteExportListRow) {
      return startFor(row, ['exporting'])
    },

    resume() {
      return run('resume the job', resumeJob)
    },

    stop() {
      stopJob()
    },

    discard() {
      return run('discard the job', discardJob)
    },

    /**
     * Forget one list's offline copy, and a stopped job on it. The work text it
     * held stays — it is keyed by work, may belong to another list, and is the
     * expensive half; *Cached work text* is where what this strands is
     * discarded, or where all of it is. A saved list whose copy it was stays,
     * not cached.
     */
    async deleteList(row: SiteExportListRow) {
      const name = listName(row)
      await forget([row.key])
      toast(`Removed the offline copy of “${name}”. Its cached work text is still here.`, { type: 'success' })
    },

    /**
     * Forget saved list `id`'s offline copy: every copy stored at its address
     * ({@link listCopies}), so no older sort order of its search stands in for
     * it, and a stopped job on any of them. The list stays, not cached, and so
     * does the work text, as `deleteList` leaves it.
     */
    async removeListCopies(id: string) {
      const keys = listCopies(savedLists.current(), id, storedListRefs(await cache.get('searchLists')))
      const row = savedRows.value.find(one => one.id === id)
      const name = row?.title || row?.placeholder || ''
      await forget(keys)
      toast(`Removed the offline copy of “${name}”. Its cached work text is still here.`, { type: 'success' })
    },

    /**
     * Remove saved list `id`: its record, its entry, and every copy stored at
     * its address, unless another list there still claims them. The copies go
     * first, so that no moment has copies at an address with no record, which
     * the background would make a list of its own.
     */
    async removeList(id: string) {
      const { dropCopies } = planRemoveList(savedLists.current(), id, storedListRefs(await cache.get('searchLists')))
      await forget(dropCopies)
      const before = savedLists.current()
      savedLists.apply(before, planRemoveList(before, id, []).state)
    },

    /**
     * Start tracking the stored list `key`, which no saved list is at yet, so
     * its new and updated works turn up in the review stream: a list the reader
     * already has becomes tracked without going back to AO3 to press a pill.
     *
     * What is tracked is the saved list the stored one is, under its own id
     * ({@link planTrackCopy}), and its title — or, for one with none, the title a
     * list tracked from its page gets, "Type: entity" made unique, so the two
     * ways in agree. The stored snapshot is left exactly as it is: tracking reads
     * the archive by date from today onwards, so however many years of works the
     * snapshot holds, none of them reaches the review.
     */
    trackCopy(key: string) {
      const row = rowFor(key)
      const before = savedLists.current()
      const plan = row ? planTrackCopy(before, refOf(row), utcToday()) : null
      if (!row || !plan) {
        toast('This list can\'t be tracked.', { type: 'error' })
        return
      }
      if (!plan.ok) {
        if ('twin' in plan)
          toast(`“${listName(row)}” is already tracked.`)
        else
          toast(`Another list is already called “${plan.takenBy.title.trim()}”. Give one of them another title under Saved lists first.`, { type: 'error' })
        return
      }
      savedLists.apply(before, plan.state)
      const title = plan.state.saved.lists[plan.id]?.title ?? ''
      toast(`Tracking “${title}”. Works added or updated from today on will turn up in your review.`, { type: 'success' })
    },

    /**
     * Replay a file of changes made inside an export
     * ({@link file://../../content_script/siteExport/importChanges.ts}).
     *
     * `tellArchive` is the reader's, because it is the half that reaches outside
     * this device: marking a work read here also takes it off their Marked for
     * Later list on AO3. Held ops stay owed, so importing the same file later
     * with the archive included picks up exactly those.
     */
    async importChanges(file: File, opts: { tellArchive?: boolean } = {}) {
      if (importingChanges.value)
        return
      importingChanges.value = true
      changeReport.value = null
      try {
        const report = await replayChangeFile(await file.text(), { tellArchive: opts.tellArchive !== false })
        changeReport.value = report
        toast(describeChangeReport(report), { type: report.archiveFailed.length ? 'error' : 'success' })
      }
      catch (err) {
        toast(err instanceof Error ? err.message : 'That file of changes could not be read.', { type: 'error' })
      }
      finally {
        importingChanges.value = false
      }
      await reload()
    },

    /**
     * Delete the cached text and the stored blurbs of works no stored list holds
     * any more.
     *
     * The counterpart to `deleteList`, which deliberately leaves both behind:
     * without this there is no way back from that but deleting every cached work
     * and spending the hours of AO3 requests again. The listed set is read here
     * rather than taken from {@link orphans}, so what is discarded is measured
     * against the lists as they stand and not as the row was drawn.
     */
    async discardOrphans() {
      const listed = await snapshotWorkIds()
      const discarded = await discardOrphanedWorkText(listed)
      const blurbs = await discardOrphanedBlurbs(listed)
      await reload()
      const parts: string[] = []
      if (discarded.usage.cached)
        parts.push(`${discarded.usage.cached.toLocaleString()} cached works (${formatBytes(discarded.usage.bytes)})`)
      else if (discarded.workIds.length)
        parts.push(`${discarded.workIds.length.toLocaleString()} leftover work text entries`)
      if (blurbs.ids.length)
        parts.push(`${blurbs.ids.length.toLocaleString()} blurbs (${formatBytes(blurbs.bytes)})`)
      toast(
        parts.length
          ? `Discarded ${parts.join(' and ')} that no list holds.`
          : 'Everything stored still belongs to a stored list.',
        { type: 'success' },
      )
    },

    async purge() {
      const purged = await purgeWorkText()
      await reload()
      toast(
        purged.cached
          ? `Deleted ${purged.cached.toLocaleString()} cached works (${formatBytes(purged.bytes)}).`
          : 'There was no cached work text to delete.',
        { type: 'success' },
      )
    },
  }

  function startFor(row: SiteExportListRow, steps: ExportJobPhase[], retryNow?: boolean) {
    if (!row.descriptor)
      return Promise.resolve(toast('Open this list on AO3 once, so the extension learns how to fetch it.', { type: 'error' }))
    const descriptor = row.descriptor
    return run('start the job', () => startJob({ cacheKey: row.key, descriptor, steps, retryNow }))
  }
}

/**
 * What an import came to, in one line: *"applied 34 · 3 already applied · 1
 * skipped"*.
 *
 * Every bucket that has anything in it is named, and none that is empty — a
 * clean run should read as one word rather than as a row of zeros to check. The
 * per-work detail behind the last two lives in the row, not here.
 */
export function describeChangeReport(report: ChangeImportReport): string {
  const parts = [`applied ${report.applied.toLocaleString()}`]
  if (report.duplicates)
    parts.push(`${report.duplicates.toLocaleString()} already applied`)
  if (report.toldArchive)
    parts.push(`${report.toldArchive.toLocaleString()} marked read on AO3`)
  // Only ever said when it happened, and it is meant to be read as an
  // explanation rather than as a bucket: AO3 would not take these from the
  // extension itself, so an open AO3 tab made the request instead.
  if (report.viaTab)
    parts.push(`${report.viaTab.toLocaleString()} through an AO3 tab`)
  if (report.archiveHeld)
    parts.push(`${report.archiveHeld.toLocaleString()} not sent to AO3`)
  if (report.archiveFailed.length)
    parts.push(`${report.archiveFailed.length.toLocaleString()} AO3 would not take`)
  if (report.skipped.length)
    parts.push(`${report.skipped.length.toLocaleString()} skipped`)
  if (report.unreadable)
    parts.push(`${report.unreadable.toLocaleString()} unreadable`)
  return report.total ? parts.join(' · ') : 'That file had no changes in it.'
}
