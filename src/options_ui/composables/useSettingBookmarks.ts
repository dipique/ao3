import { currentBookmarks } from '../model/anchors.ts'
import { toggleBookmark } from '../model/rail.ts'
import { useOption } from './useOptions.ts'

/**
 * The settings rows the reader bookmarked, by key, which the rail lists as
 * links to them (see {@link file://../model/rail.ts}). One stored under
 * another of its row's ids is read as its key ({@link currentBookmarks}), and
 * a change stores them all by key.
 */
export function useSettingBookmarks() {
  const { ids: stored } = useOption('bookmarkedSettings')
  const ids = computed(() => currentBookmarks(stored.value))
  return {
    ids,
    isBookmarked: (id: string) => ids.value.includes(id),
    toggle: (id: string) => {
      stored.value = toggleBookmark(ids.value, id)
    },
  }
}
