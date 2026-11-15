import { toggleBookmark } from '../model/rail.ts'
import { useOption } from './useOptions.ts'

/**
 * The settings rows the reader bookmarked, by anchor id, which the rail lists
 * as links to them (see {@link file://../model/rail.ts}).
 */
export function useSettingBookmarks() {
  const { ids } = useOption('bookmarkedSettings')
  return {
    ids,
    isBookmarked: (id: string) => ids.value.includes(id),
    toggle: (id: string) => {
      ids.value = toggleBookmark(ids.value, id)
    },
  }
}
