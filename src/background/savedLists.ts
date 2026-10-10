import { cache, createLogger, createSavedListsReconciler, moveKeys, options, planListingRefile, savedListsWrite, SITE_EXPORT_JOB_KEY } from '#common'

const logger = createLogger('SavedLists')

/**
 * The background's half of saved lists: the planner, run against what storage
 * holds now, one run at a time, writing back only what it changed
 * ({@link createSavedListsReconciler}). It is the migration — run by
 * `migrate()` on every install, update and import — and the reconciliation that
 * keeps the records in step with the synced entries and the stored lists
 * ({@link watchSavedLists}). The sync engine runs it too, just before it
 * applies a pull.
 */
export const reconcileSavedLists = createSavedListsReconciler({
  async read() {
    const [{ trackedLists, savedLists }, searchLists] = await Promise.all([
      options.get(['trackedLists', 'savedLists']),
      cache.get('searchLists'),
    ])
    return { trackedLists, savedLists, searchLists }
  },
  write: update => options.set(update),
})

/**
 * Refile what was kept under an address a listing's key no longer gives
 * ({@link planListingRefile}): each copy goes to its listing's address with
 * what it failed to find, a stopped site export job on it follows it, and lists
 * that are one search now are made one. Run by `migrate()`; running it again
 * changes nothing.
 */
export async function refileListings(): Promise<void> {
  const [{ trackedLists, savedLists }, { searchLists, searchMisses }] = await Promise.all([
    options.get(['trackedLists', 'savedLists']),
    cache.get(['searchLists', 'searchMisses']),
  ])
  const state = { tracked: trackedLists, saved: savedLists }
  const plan = planListingRefile(state, searchLists)

  if (plan.moves.length) {
    const lists = moveKeys(searchLists, plan.moves)
    const misses = moveKeys(searchMisses, plan.moves)
    await cache.set({ searchLists: lists, ...(misses !== searchMisses ? { searchMisses: misses } : {}) })
    const job = (await browser.storage.local.get(SITE_EXPORT_JOB_KEY))[SITE_EXPORT_JOB_KEY]
    const to = typeof job?.cacheKey === 'string' ? new Map(plan.moves).get(job.cacheKey) : undefined
    if (to)
      await browser.storage.local.set({ [SITE_EXPORT_JOB_KEY]: { ...job, cacheKey: to } })
  }

  const update = savedListsWrite(state, plan.state)
  if (Object.keys(update).length)
    await options.set(update)
}

/**
 * Run the planner whenever the synced entries or the stored lists change —
 * which a pull, a restore, an import, the floating toolbar and a search view
 * all do — once `ready` says this background is the build on disk. Registered
 * as the background starts, so no change that wakes it is missed.
 */
export function watchSavedLists(ready: Promise<boolean>): void {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !('option.trackedLists' in changes || 'cache.searchLists' in changes))
      return
    void ready
      .then(isCurrent => (isCurrent ? reconcileSavedLists() : undefined))
      .catch(error => logger.error('Could not bring the saved lists into step.', error))
  })
}
