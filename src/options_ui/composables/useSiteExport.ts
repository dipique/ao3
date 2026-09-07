import type { SnapshotDescriptor } from '#common'
import type { ExportJobPhase, JobStatus } from '#content_script/siteExport/job.js'
import type { WorkTextUsage } from '#content_script/siteExport/workText.js'

import { toast } from '#common'
import { listSnapshots } from '#content_script/searchView/cache.js'
import { discardJob, jobStatus, loadJob, resumeJob, startJob, stopJob, subscribeJob } from '#content_script/siteExport/job.js'
import { summarizeWorkText } from '#content_script/siteExport/workText.js'
import { purgeWorkText, readWorkTextIndex } from '#content_script/siteExport/workTextCache.js'

/**
 * The options page's view of the site export: one row per stored list, the job
 * runner's live status, and the cache read-out underneath.
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
  if (!row.descriptor)
    parts.push('open this list on AO3 once to enable refreshing it from here')
  return parts.join(' · ')
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
    usage,
    loading,
    status,
    resumable,
    reload,

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
