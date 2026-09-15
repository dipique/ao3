import { ADDON_CLASS } from '#common'

/**
 * Taking a blurb back to what the store keeps: the markup as AO3 served it
 * ({@link pristineBlurb}), with the part that belongs to one list rather than
 * to the work set aside ({@link normalizeBlurb}).
 */

/** The attribute prefix of every `data-*` the extension stamps on a page. */
const DATA_PREFIX = 'data-ao3e-'

/** The custom-property prefix the highlight units colour native elements with. */
const STYLE_PREFIX = '--ao3e-'

/**
 * A copy of a blurb as AO3 served it, with everything the extension did to it
 * taken back off — or, given `{ inPlace: true }`, the blurb itself stripped.
 *
 * A snapshot is the blurbs *before* decoration, because opening one decorates
 * it: store a decorated blurb and the next open adds a second star after every
 * highlighted tag, a second clock after the title, a second "Mark as Read". And
 * a list is not always written before its blurbs are decorated — a blurb action
 * writes the list it is showing, a top-up keeps the stored works it already
 * put on screen — so the write can't simply be timed to miss it.
 *
 * Nearly everything the units add is marked with {@link ADDON_CLASS}: nodes
 * carry the class itself, classes put on native elements start with it, and so
 * do their `data-ao3e-*` attributes and `--ao3e-*` colours. The exceptions are
 * undone by name — HideWorks' wrapper around a hidden work's children and the
 * `hidden` it sets on the `<li>`, Stats' unmarked `<div>` around each `dt`/`dd`
 * pair and the reformatted numbers it stashes the originals of.
 */
export function pristineBlurb<T extends Element>(blurb: T, { inPlace = false } = {}): T {
  const li = inPlace ? blurb : blurb.cloneNode(true) as T
  const unwrap = (el: Element): void => {
    el.replaceWith(...el.childNodes)
  }

  li.querySelectorAll(`.${ADDON_CLASS}--hide-works--wrapper`).forEach(unwrap)
  li.removeAttribute('hidden')
  // AO3's own stats list holds nothing but `dt`/`dd` pairs.
  li.querySelectorAll('dl.stats > div').forEach(unwrap)
  li.querySelectorAll<HTMLElement>(`[${DATA_PREFIX}original]`).forEach((el) => {
    el.textContent = el.dataset.ao3eOriginal!
  })
  li.querySelectorAll(`.${ADDON_CLASS}`).forEach(el => el.remove())

  for (const el of [li, ...li.querySelectorAll('*')]) {
    for (const name of [...el.classList]) {
      if (name === ADDON_CLASS || name.startsWith(`${ADDON_CLASS}--`))
        el.classList.remove(name)
    }
    if (el.getAttribute('class') === '')
      el.removeAttribute('class')
    for (const { name } of [...el.attributes]) {
      if (name.startsWith(DATA_PREFIX))
        el.removeAttribute(name)
    }
    if (el instanceof HTMLElement && el.style.length) {
      for (const prop of [...el.style]) {
        if (prop.startsWith(STYLE_PREFIX))
          el.style.removeProperty(prop)
      }
      if (!el.style.length)
        el.removeAttribute('style')
    }
  }
  return li
}

/** The block a readings page ends each blurb with: last visited, visit count, "Marked for Later". */
const READING_MODULE_SELECTOR = ':scope > div.user.module.group'

/**
 * Take the list-specific block off a pristine blurb, in place, and return it —
 * forms removed — as the markup the list keeps for this work.
 *
 * A readings page (Marked for Later, History) ends every blurb with a block
 * that is about the reader's visits rather than the work, and carries a
 * "Delete from History" form holding the session's `authenticity_token`. Blurbs
 * are shared by every list holding their work, so the block can't stay in the
 * shared copy: a tag search refreshing it would take "Last visited" off the read
 * list, and a readings scrape would put it on the tag search. The token goes
 * altogether — it has no business in storage, or in an exported file.
 *
 * The same split, done on a string where there is no DOM, is
 * `splitReadingModule` in {@link file://../../common/blurbRecord.ts}.
 */
export function normalizeBlurb(li: HTMLLIElement): string | undefined {
  li.classList.remove('reading')
  const block = li.querySelector(READING_MODULE_SELECTOR)
  if (!block)
    return undefined
  block.remove()
  block.querySelectorAll('form').forEach(form => form.remove())
  return block.outerHTML
}
