import { buildRail } from '../model/rail.ts'
import { useNav } from './useNav.ts'
import { useOptionSearch } from './useOptionSearch.ts'

/**
 * The category the pane shows, and the rail that lists them all. What the rail
 * holds, and which categories the pane shows with or without a query, is
 * {@link file://../model/rail.ts}; this holds the current category and wires
 * the rail to the page's categories and settings search.
 *
 * The current category is set by the hash (see {@link file://./useHashNav.ts}),
 * and a running query leaves it alone, so clearing the query brings it back.
 * Until a hash has set one, it is the first category.
 */

const chosen = ref<string | null>(null)

const { categories, subsections } = useNav()
const { query, entries } = useOptionSearch()

const current = computed(() => chosen.value ?? categories.value[0]?.id ?? '')

const rail = computed(() => buildRail(entries.value, categories.value.map(c => c.title), query.value, current.value, subsections.value))

export function useCurrentCategory() {
  return {
    /** The current category's id. */
    current,
    rail,
    /** Make the category with this id current. */
    show: (id: string) => {
      chosen.value = id
    },
    /** Whether the pane shows the category with this id. */
    inPane: (id: string) => rail.value.find(category => category.id === id)?.inPane ?? false,
  }
}
