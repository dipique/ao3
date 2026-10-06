import type { ListState } from '#common'

import { deepToRaw, savedListsWrite } from '#common'

/**
 * The saved lists' two halves as this page holds them — the synced entries
 * (`trackedLists`) and this browser's records (`savedLists`) — for the plans in
 * `savedLists.ts` to read, and what a plan returns written back.
 *
 * Only a half the plan changed is written, so a plan that touched only the
 * records writes nothing that syncs.
 */
export function useSavedLists() {
  const tracked = useOption('trackedLists')
  const { lists: records } = useOption('savedLists')

  /** Both halves, as plain data, as they stand now. */
  function current(): ListState {
    return deepToRaw({
      tracked: { enabled: tracked.enabled.value, target: tracked.target.value, reviewedThrough: tracked.reviewedThrough.value, lists: tracked.lists.value },
      saved: { lists: records.value },
    })
  }

  /** Write what `next` changed from `before`, the state a plan was given. */
  function apply(before: ListState, next: ListState): void {
    const { trackedLists, savedLists } = savedListsWrite(before, next)
    if (savedLists)
      records.value = savedLists.lists
    if (trackedLists)
      tracked.lists.value = trackedLists.lists
  }

  return { entries: tracked.lists, records, current, apply }
}
