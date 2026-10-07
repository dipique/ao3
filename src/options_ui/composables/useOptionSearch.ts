import type { SettingsRow } from '../model/settingsSearch.ts'

import { anchorSlug } from '../model/anchors.ts'
import { entryMatches, highlight as highlightTerms, highlightWithStrong, searchTerms } from '../model/settingsSearch.ts'
import { registerAnchor } from './useAnchors.ts'

/**
 * Page-wide search over the option rows. What a query keeps, and how its hits
 * are marked, is {@link file://../model/settingsSearch.ts}.
 *
 * Rows register themselves from `OptionRow` — the one component every row on the
 * page routes through, composite rows included — so the index is whatever is
 * actually rendered rather than a list that has to be kept in step by hand.
 * Matching is over title **and** description, because the description is where
 * most of what a reader is looking for is written.
 *
 * Which categories a query shows is the rail's to say; see
 * {@link file://./useCurrentCategory.ts}.
 */

const query = ref('')
const rows = ref(new Map<string, SettingsRow>())
/** Which row each id in {@link rows} is, so a row lets go only of an id that is still its own. */
const owners = new Map<string, symbol>()

const terms = computed(() => searchTerms(query.value))
const searching = computed(() => terms.value.length > 0)

/** A row the index doesn't hold is kept. */
function rowKept(entry: SettingsRow | undefined): boolean {
  return !entry || entryMatches(entry, terms.value)
}

function highlight(text: string): string {
  return highlightTerms(text, terms.value)
}

/** {@link highlight}, with `strong`'s phrases drawn bold. */
function highlightStrong(text: string, strong: readonly string[]): string {
  return highlightWithStrong(text, terms.value, strong)
}

export function useOptionSearch() {
  return {
    query,
    searching,
    highlight,
    highlightStrong,
    /** Every row on the page, in the order they registered. */
    entries: computed(() => [...rows.value.values()]),
    total: computed(() => rows.value.size),
    matchCount: computed(() => [...rows.value.values()].filter(rowKept).length),
    /** True when a category has at least one matching row (always true when idle). */
    categoryMatches: (category: string) =>
      !searching.value || [...rows.value.values()].some(e => e.category === category && rowKept(e)),
    /** Same, for one sub-section within its category. */
    subsectionMatches: (category: string | null, subsection: string) =>
      !searching.value || [...rows.value.values()].some(e => e.category === category && e.subsection === subsection && rowKept(e)),
    /** Whether one row, by its anchor id, survives the current search. */
    rowMatches: (id: string) => rowKept(rows.value.get(id)),
    clear: () => { query.value = '' },
  }
}

/**
 * Registers one row and returns everything `OptionRow` needs to render itself:
 * a stable id to anchor and label by, whether the current search keeps it, and
 * its title/description with search hits marked.
 *
 * The id is a slug of the sub-section plus the title, so the two rows called
 * "Reading time" (work stats and chapter stats) get distinct, readable anchors.
 * A row whose title is the reader's, which two rows can share, passes an
 * `anchor` of its own, which follows the title as the reader changes it: the
 * row is indexed and found under the anchor it has now. `id` is the one it
 * started with.
 */
export function useSearchableRow(source: () => { title: string, subtitle: string }, anchor?: () => string) {
  const category = OptionCategoryName.inject(null)
  const subsection = OptionSubsectionName.inject(null)
  const fixed = anchorSlug(subsection ? `${subsection} ${source().title}` : source().title)
  const current = computed(() => anchor?.() ?? fixed)
  const id = current.value

  if (process.env.NODE_ENV === 'development' && rows.value.has(id))
    console.warn(`[options] duplicate option row id "${id}" — give one of them a distinct title or sub-section`)

  // Unlike the search index above, the anchor registry keeps the row after it
  // unmounts, and under an anchor it has left; see {@link registerAnchor}.
  watchEffect(() => registerAnchor({ id: current.value, kind: 'row', name: source().title, category, subsection }))

  // A watcher rather than a one-shot write: a few descriptions are computed
  // (the fandom export counts its ids), so the index has to follow them. An
  // anchor left behind is taken out only while it is still this row's, since
  // another row may have taken it up in the same update.
  const owner = Symbol(id)
  let indexed: string | null = null
  const unindex = (): void => {
    if (indexed !== null && owners.get(indexed) === owner) {
      rows.value.delete(indexed)
      owners.delete(indexed)
    }
  }
  watchEffect(() => {
    const key = current.value
    if (key !== indexed)
      unindex()
    indexed = key
    owners.set(key, owner)
    rows.value.set(key, { category, subsection, ...source() })
  })
  onUnmounted(unindex)

  return {
    id,
    /** Id of the row's control, kept distinct from the row's own anchor id. */
    controlId: `${id}-input`,
    visible: computed(() => rowKept(rows.value.get(current.value))),
    titleHtml: computed(() => highlight(source().title)),
    subtitleHtml: computed(() => highlight(source().subtitle)),
  }
}
