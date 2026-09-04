import { restoreCollapsed, stashCollapsed } from './useCategoryCollapse.ts'

/**
 * Page-wide search over the option rows, plus the "show descriptions" switch.
 *
 * Rows register themselves from `OptionRow` — the one component every row on the
 * page routes through, composite rows included — so the index is whatever is
 * actually rendered rather than a list that has to be kept in step by hand.
 * Matching is over title **and** description, because the description is where
 * most of what a reader is looking for is written.
 *
 * @see {@link file://./useCategoryCollapse.ts} — a category with matches is
 * forced open while a search is running, whatever its collapsed state.
 */

export interface OptionRowEntry {
  category: string | null
  subsection: string | null
  title: string
  subtitle: string
}

/** Per-device, like the collapse state: a preference about this page, not a setting. */
const LS_DESCRIPTIONS = 'ao3e:options:descriptions'

const query = ref('')
const rows = ref(new Map<string, OptionRowEntry>())

function storedDescriptions(): boolean {
  try {
    return localStorage.getItem(LS_DESCRIPTIONS) !== '0'
  }
  catch {
    return true
  }
}

/**
 * Unlike the collapse state this *is* persisted. Folding a category away is a
 * navigation move for right now; "I know what these do, stop showing me the
 * paragraphs" is a standing preference, and having to set it on every visit
 * would defeat it.
 */
const showDescriptions = ref(storedDescriptions())

watch(showDescriptions, (value) => {
  try {
    localStorage.setItem(LS_DESCRIPTIONS, value ? '1' : '0')
  }
  catch {
    // Private mode / blocked storage — the switch still works for this visit.
  }
})

/**
 * Anchor id for a row. Deliberately not `kebabCase`, which splits on case
 * boundaries and turns "Compress filter URLs" into `compress-filter-ur-ls`.
 */
function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Lowercase and strip accents, so "précis" is found by typing "precis". */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** Every whitespace-separated term must appear somewhere in title + description. */
const terms = computed(() => normalize(query.value).split(/\s+/).filter(Boolean))
const searching = computed(() => terms.value.length > 0)

function entryMatches(entry: OptionRowEntry | undefined): boolean {
  if (!entry)
    return true
  const haystack = normalize(`${entry.title} ${entry.subtitle}`)
  return terms.value.every(term => haystack.includes(term))
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[char]!))
}

/**
 * Escapes `text`, then wraps every occurrence of a search term in `<mark>`.
 * Escaping first is what makes the result safe to hand to `v-html`; the marks are
 * the only tags that can come out of it.
 */
function highlight(text: string): string {
  const escaped = escapeHtml(text)
  if (!searching.value)
    return escaped

  // Work on the normalized copy so the match positions line up with an
  // accent-insensitive query, then slice out of the escaped original.
  const hay = normalize(escaped)
  const spans: Array<[number, number]> = []
  for (const term of terms.value) {
    let from = 0
    for (;;) {
      const at = hay.indexOf(term, from)
      if (at === -1)
        break
      spans.push([at, at + term.length])
      from = at + term.length
    }
  }
  if (!spans.length)
    return escaped

  // Merge overlapping hits so two terms matching the same run produce one mark.
  spans.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [start, end] of spans) {
    const last = merged.at(-1)
    if (last && start <= last[1])
      last[1] = Math.max(last[1], end)
    else
      merged.push([start, end])
  }

  let out = ''
  let at = 0
  for (const [start, end] of merged) {
    out += `${escaped.slice(at, start)}<mark>${escaped.slice(start, end)}</mark>`
    at = end
  }
  return out + escaped.slice(at)
}

// A category collapsed by the reader would swallow its own search hits, so a
// running query puts every fold aside and gives them back when it clears.
watch(searching, on => on ? stashCollapsed() : restoreCollapsed())

export function useOptionSearch() {
  return {
    query,
    searching,
    showDescriptions,
    highlight,
    total: computed(() => rows.value.size),
    matchCount: computed(() => [...rows.value.values()].filter(entryMatches).length),
    /** True when a category has at least one matching row (always true when idle). */
    categoryMatches: (category: string) =>
      !searching.value || [...rows.value.values()].some(e => e.category === category && entryMatches(e)),
    /** Same, for one sub-section within its category. */
    subsectionMatches: (category: string | null, subsection: string) =>
      !searching.value || [...rows.value.values()].some(e => e.category === category && e.subsection === subsection && entryMatches(e)),
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
 */
export function useSearchableRow(source: () => { title: string, subtitle: string }) {
  const category = OptionCategoryName.inject(null)
  const subsection = OptionSubsectionName.inject(null)
  const id = slug(subsection ? `${subsection} ${source().title}` : source().title)

  if (process.env.NODE_ENV === 'development' && rows.value.has(id))
    console.warn(`[options] duplicate option row id "${id}" — give one of them a distinct title or sub-section`)

  // A watcher rather than a one-shot write: a few descriptions are computed
  // (the fandom export counts its ids), so the index has to follow them.
  watchEffect(() => {
    rows.value.set(id, { category, subsection, ...source() })
  })
  onUnmounted(() => rows.value.delete(id))

  return {
    id,
    /** Id of the row's control, kept distinct from the row's own anchor id. */
    controlId: `${id}-input`,
    visible: computed(() => entryMatches(rows.value.get(id))),
    showDescriptions,
    searching,
    titleHtml: computed(() => highlight(source().title)),
    subtitleHtml: computed(() => highlight(source().subtitle)),
  }
}
