import type { ListState, SavedList, TrackedList } from '#common'

import { deepToRaw, planRetitle, planStopTracking, planTrack, savedListsWrite, utcToday } from '#common'

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

  /**
   * Give list `id` a title: on its record, and on its entry while it is
   * tracked. A title another list has is refused, and the list that has it is
   * returned; null once it is written.
   */
  function retitle(id: string, title: string): SavedList | null {
    const before = current()
    const plan = planRetitle(before, id, title)
    if (!plan.ok)
      return plan.takenBy
    apply(before, plan.state)
    return null
  }

  /**
   * Track list `id`, or stop tracking it, keeping it, title and all, as a saved
   * list on this browser. Tracking starts the clock afresh, from today: a
   * stretch spent untracked is the reader saying "not these for now", so
   * tracking again shouldn't pour back everything they chose to skip. Tracking
   * a search another tracked list is already is refused, and that list is
   * returned; null once it is written.
   */
  function setTracked(id: string, on: boolean): TrackedList | null {
    const before = current()
    if (!on) {
      apply(before, planStopTracking(before, id))
      return null
    }
    const plan = planTrack(before, id, utcToday())
    if (!plan.ok)
      return plan.twin
    apply(before, plan.state)
    return null
  }

  return { entries: tracked.lists, records, current, apply, retitle, setTracked }
}
