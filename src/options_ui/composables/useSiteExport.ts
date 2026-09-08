import type { SnapshotDescriptor } from '#common'
import type { ChangeImportReport } from '#content_script/siteExport/importChanges.js'
import type { ExportJobPhase, JobStatus } from '#content_script/siteExport/job.js'
import type { WorkTextUsage } from '#content_script/siteExport/workText.js'

import { getArchiveLink, toast } from '#common'
import { deleteSnapshot, listSnapshots } from '#content_script/searchView/cache.js'
import { importChanges as replayChangeFile } from '#content_script/siteExport/importChanges.js'
import { discardJob, jobStatus, loadJob, resumeJob, startJob, stopJob, subscribeJob } from '#content_script/siteExport/job.js'
import { summarizeWorkText } from '#content_script/siteExport/workText.js'
import { purgeWorkText, readWorkTextIndex } from '#content_script/siteExport/workTextCache.js'

/**
 * The options page's view of the site export: one row per stored list, the job
 * runner's live status, the cache read-out underneath, and the way back in for
 * the changes a reader made inside an exported file.
 *
 * Module-level state, like {@link file://./useSync.ts}, because the runner it
 * mirrors is itself a singleton — there is one job for the whole extension, so
 * two components asking for it must see the same one.
 */

/** One stored list, as a row in Advanced → Site export. */
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
  /** Works in this list whose text is cached. */
  cached: number
  /** Works in this list whose last fetch failed. */
  failed: number
  /** Works in this list with no cached text at all. */
  uncached: number
  /** Bytes of cached text belonging to this list. */
  bytes: number
  /** The read-out under the title, and the row's search haystack. */
  summary: string
}

const rows = ref<SiteExportListRow[]>([])
const usage = ref<WorkTextUsage>({ cached: 0, failed: 0, bytes: 0 })
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

subscribeJob((next) => {
  status.value = next
})

/** A job that stopped short leaves a queue behind; that is the whole resume test. */
const resumable = computed(() => {
  const job = status.value.job
  return !!job && !status.value.running && (job.steps.length > 0 || job.queue.length > 0)
})

/** Re-read the lists and the cache index. Cheap enough to run after every action. */
async function reload(): Promise<void> {
  const [snapshots, index] = await Promise.all([listSnapshots(), readWorkTextIndex()])
  usage.value = summarizeWorkText(index)
  rows.value = snapshots.map((snapshot) => {
    let cached = 0
    let failed = 0
    let bytes = 0
    for (const workId of snapshot.workIds) {
      const meta = index[workId]
      if (!meta)
        continue
      if (meta.size > 0) {
        cached++
        bytes += meta.size
      }
      if (meta.failure)
        failed++
    }
    const row: SiteExportListRow = {
      key: snapshot.key,
      label: snapshot.descriptor?.label ?? snapshot.key,
      descriptor: snapshot.descriptor,
      listUrl: listUrlFor(snapshot.key, snapshot.descriptor),
      scrapedAt: snapshot.scrapedAt,
      count: snapshot.count,
      cached,
      failed,
      uncached: Math.max(0, snapshot.count - cached),
      bytes,
      summary: '',
    }
    row.summary = summarize(row)
    return row
  })
  loading.value = false
}

/**
 * Where a stored list lives on AO3 — the descriptor's own address, or, failing
 * that, one rebuilt from the cache key.
 *
 * The fallback is the point rather than a nicety. A snapshot written before
 * descriptors existed has no address, and it is exactly the row that needs one:
 * the only way to make it refreshable again is to open the list on AO3 and press
 * its search button. What makes rebuilding honest is that every `SearchSource`
 * keys its snapshot on precisely the part of the address that identifies the
 * list — a username, a tag's path segment, a search's own query — so the three
 * shapes invert cleanly and a key that fits none of them simply gets no link.
 */
function listUrlFor(key: string, descriptor?: SnapshotDescriptor): string | undefined {
  if (descriptor?.listUrl)
    return descriptor.listUrl

  const split = key.indexOf(':')
  const rest = split < 0 ? '' : key.slice(split + 1)
  if (!rest)
    return undefined

  switch (key.slice(0, split)) {
    case 'marked-for-later':
      return getArchiveLink(`/users/${rest}/readings?show=to-read`)
    // Already escaped the way AO3 escapes a tag in a path, which is why the key
    // holds the raw segment rather than the tag's name.
    case 'tag-works':
      return getArchiveLink(`/tags/${rest}`)
    case 'series-works':
      return getArchiveLink(`/series/${rest}`)
    // The search's own query string, minus the page it was read from.
    case 'text-search':
      return getArchiveLink(`/works/search?${rest}`)
    default:
      return undefined
  }
}

function summarize(row: SiteExportListRow): string {
  const parts = [
    `${row.count.toLocaleString()} ${row.count === 1 ? 'work' : 'works'}`,
    `list refreshed ${ago(row.scrapedAt)}`,
    row.cached
      ? `${row.cached.toLocaleString()} cached (${formatBytes(row.bytes)})`
      : 'nothing cached yet',
  ]
  if (row.uncached)
    parts.push(`${row.uncached.toLocaleString()} not cached`)
  if (row.failed)
    parts.push(`${row.failed.toLocaleString()} failed`)
  return parts.join(' · ')
}

/**
 * What to do about a list stored before descriptors existed, in the reader's
 * words — shown under the row's buttons, since it is about the buttons being
 * off rather than about the list's contents.
 *
 * It has to name the *view*, not the page. Opening the listing on AO3 does
 * nothing at all: the descriptor is written when the search view scrapes, which
 * is a button the reader has to press. The old wording ("open this list on AO3
 * once") sent people to the page, where they could follow it exactly and see
 * nothing change.
 */
export const NO_DESCRIPTOR_NOTE
  = 'Stored before this list knew how to re-fetch itself. Open it on AO3 — the link beside its name — and press the search button '
    + '(Search Marked for Later, or the search button on a tag or search-results page) — that scrape teaches '
    + 'the extension where the list lives, and these buttons come back. If it stays like this, the list is '
    + 'from an account or address that no longer resolves; delete it.'

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
    usage,
    loading,
    status,
    resumable,
    reload,
    changeReport,
    importingChanges,

    /** Re-scrape a list, without touching the work text. */
    refreshList(row: SiteExportListRow) {
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
      return startFor(row, ['refreshing', 'caching'])
    },

    /**
     * The one-button path: refresh the list, fetch whatever the cache is
     * missing, then write the zip. Long, and the progress bar says so.
     */
    downloadSite(row: SiteExportListRow) {
      return startFor(row, ['refreshing', 'caching', 'exporting'])
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
     * Forget one list. The work text it held stays — it is keyed by work, may
     * belong to another list, and is the expensive half; the row underneath is
     * where all of it is deleted at once.
     */
    async deleteList(row: SiteExportListRow) {
      await deleteSnapshot(row.key)
      await reload()
      toast(`Removed “${row.label}”. The cached work text is still here.`, { type: 'success' })
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

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** Largest unit first would read "0 years ago"; smallest first stops at the right one. */
const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.345],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

/** "2 hours ago", from an epoch. Not exported: a global called `ago` is a trap. */
function ago(timestamp: number): string {
  if (!timestamp)
    return 'never'
  let value = (timestamp - Date.now()) / 1000
  for (const [unit, span] of RELATIVE_STEPS) {
    if (Math.abs(value) < span)
      return RELATIVE.format(Math.round(value), unit)
    value /= span
  }
  return RELATIVE.format(Math.round(value), 'year')
}

/** Bytes at a readable scale — the cache runs to tens of megabytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
