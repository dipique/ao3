import { cache, createLogger, options, planSavedLists, savedListsWrite, storedListRefs } from '#common'

const logger = createLogger('SavedLists')

/**
 * The background's half of saved lists: the planner ({@link planSavedLists}),
 * run against what storage holds now, writing back only what it changed. It is
 * the migration — run by `migrate()` on every install, update and import — and
 * the reconciliation that keeps the records in step with the synced entries and
 * the stored lists ({@link watchSavedLists}). The sync engine runs it too, just
 * before it applies a pull.
 *
 * One run at a time, each reading storage afresh: every run is a read, a plan
 * and a write, and two at once would each write what the other hadn't seen.
 */
let chain: Promise<unknown> = Promise.resolve()

export function reconcileSavedLists(): Promise<void> {
  const run = chain.then(reconcile, reconcile)
  chain = run.then(() => {}, () => {})
  return run
}

async function reconcile(): Promise<void> {
  const [{ trackedLists, savedLists }, searchLists] = await Promise.all([
    options.get(['trackedLists', 'savedLists']),
    cache.get('searchLists'),
  ])
  const state = { tracked: trackedLists, saved: savedLists }
  const update = savedListsWrite(state, planSavedLists(state, storedListRefs(searchLists)).state)
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
