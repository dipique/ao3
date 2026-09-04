/**
 * The page's anchor registry: every category, sub-section and option row, by the
 * id it renders with and the name it shows. It's what turns a `#hash` into
 * somewhere to scroll — see {@link file://./useHashNav.ts} — and it lives in its
 * own leaf module so the things that *fill* it (the rows, from
 * {@link file://./useOptionSearch.ts}) and the thing that *reads* it don't have
 * to import each other.
 *
 * Entries are never removed. A sub-section really does unmount when its category
 * folds shut, and an anchor that vanished with it could never be jumped to
 * again — which is the one case a deep link most needs to handle.
 */

export type AnchorKind = 'category' | 'subsection' | 'row'

export interface Anchor {
  /** The element's DOM id — what a `#hash` normally names. */
  id: string
  kind: AnchorKind
  /** What the page calls it, so a hash can name that instead of the id. */
  name: string
  /** Owning category and sub-section, so a jump can unfold the way in. */
  category: string | null
  subsection: string | null
}

/** Order of preference when a hash matches by name rather than by id. */
const KIND_ORDER: AnchorKind[] = ['category', 'subsection', 'row']

const anchors = new Map<string, Anchor>()

/**
 * Anchor id for anything on the page — a row, a sub-section, a category — and
 * the same normalisation a `#hash` is put through before it is looked up.
 * Deliberately not `kebabCase`, which splits on case boundaries and turns
 * "Compress filter URLs" into `compress-filter-ur-ls`.
 */
export function anchorSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

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
