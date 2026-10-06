import { anchorSlug, categoryId } from '../model/anchors.ts'

/**
 * The page's anchor registry: every category, sub-section and option row, by the
 * id it renders with and the name it shows. It's what turns a `#hash` into
 * somewhere to scroll — see {@link file://./useHashNav.ts} — and it lives in its
 * own leaf module so the things that *fill* it (the rows, from
 * {@link file://./useOptionSearch.ts}) and the thing that *reads* it don't have
 * to import each other.
 *
 * Entries are never removed, so a hash naming a row that comes and goes with
 * its data, such as a stored list's, still resolves to its category while the
 * row isn't drawn.
 */

export type AnchorKind = 'category' | 'subsection' | 'row'

export interface Anchor {
  /** The element's DOM id — what a `#hash` normally names. */
  id: string
  kind: AnchorKind
  /** What the page calls it, so a hash can name that instead of the id. */
  name: string
  /** Titles of the owning category and sub-section, so a jump can find the way in. */
  category: string | null
  subsection: string | null
}

/** Order of preference when a hash matches by name rather than by id. */
const KIND_ORDER: AnchorKind[] = ['category', 'subsection', 'row']

const anchors = new Map<string, Anchor>()

export function registerAnchor(anchor: Anchor): void {
  anchors.set(anchor.id, anchor)
}

/**
 * What `hash` names: its id, or failing that the *name* of a category,
 * sub-section or row — so `#Search` and `#Work text` work as well as their
 * slugs, and a link can be written the way the page reads.
 */
export function resolveAnchor(hash: string): Anchor | null {
  const raw = hash.replace(/^#/, '')
  let key: string
  try {
    key = anchorSlug(decodeURIComponent(raw))
  }
  catch {
    // A malformed escape sequence in the hash; take it as written.
    key = anchorSlug(raw)
  }
  if (!key)
    return null

  const byId = anchors.get(key)
  if (byId)
    return byId

  const all = [...anchors.values()]
  for (const kind of KIND_ORDER) {
    const hit = all.find(anchor => anchor.kind === kind && anchorSlug(anchor.name) === key)
    if (hit)
      return hit
  }
  return null
}

/** The id of the category `hash` lands in: the one it names, or the one holding what it names. */
export function anchorCategory(hash: string): string | null {
  const category = resolveAnchor(hash)?.category
  return category ? categoryId(category) : null
}
