/**
 * What a bare `/tags/NAME` page is — and in particular whether it is the one kind
 * of tag page the extension has anything to offer for.
 *
 * The archive only gives a tag the Sort & Filter sidebar once it has been marked
 * common (canonical). Every other tag gets a plain paged list of works and no
 * way to filter or sort it at all, which is what both of the features here are
 * about: offering to pull that list into the in-memory search view, and offering
 * to track it. Both need the same question answered — is this an uncommon tag,
 * and does it actually list any works? — so they ask it here rather than each
 * deciding for itself and disagreeing.
 */

/** Where a tag page keeps its works, as opposed to the bookmarks listed below them. */
export const TAG_LISTBOX_SELECTOR = 'div.work.listbox'
export const TAG_BLURB_SELECTOR = `${TAG_LISTBOX_SELECTOR} ul.index.group > li.blurb`

/** The tag profile block on `/tags/NAME`, or null if this isn't such a page. */
function tagProfile(): HTMLElement | null {
  // Only the bare tag URL. `/tags/NAME/works` is the filterable listing, which
  // AO3 only serves for canonical tags and which needs nothing from us.
  if (!/^\/tags\/[^/]+\/?$/.test(location.pathname))
    return null
  return document.querySelector<HTMLElement>('#main div.tag.profile')
}

/**
 * Whether AO3 has marked this tag common (canonical). Its description paragraphs
 * are the only tell on the bare tag URL: a canonical tag's says it is one and
 * links to the filterable listing, a non-canonical tag's doesn't.
 */
function isCanonical(profile: HTMLElement): boolean {
  return Array.from(profile.querySelectorAll(':scope > p')).some(p => p.innerHTML.includes('canonical'))
}

/** An uncommon tag's page, and the block of works on it. */
export interface UncommonTagPage {
  /** The tag profile block — the notice about not being filterable lives in it. */
  profile: HTMLElement
  /** The works block, which is also where the page count is read from. */
  listbox: HTMLElement
}

/**
 * This page, if it is an uncommon tag's own page *and* it lists at least one
 * work; null otherwise — a canonical tag (the archive can already filter it), a
 * tag nobody has used, or any other page.
 */
export function uncommonTagPage(): UncommonTagPage | null {
  const profile = tagProfile()
  if (!profile || isCanonical(profile))
    return null
  const listbox = profile.querySelector<HTMLElement>(`:scope > ${TAG_LISTBOX_SELECTOR}`)
  // No works listed under this tag — nothing to search, and nothing to track.
  if (!listbox || !listbox.querySelector('li.blurb'))
    return null
  return { profile, listbox }
}

/** The tag in the current path, as a reader would write it. */
export function tagPageName(): string {
  const raw = location.pathname.replace(/^\/tags\/|\/$/g, '')
  try {
    // AO3 percent-encodes `/` as `*s*` and friends in tag paths; decoding only
    // undoes the URL layer, which is the part that looks like noise in a list.
    return decodeURIComponent(raw)
  }
  catch {
    return raw
  }
}
