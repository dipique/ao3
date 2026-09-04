/**
 * What counts as "a work's own text" — the one answer shared by the unit that
 * rewrites it ({@link file://./units/TextReplace.ts}) and the on-page tools that
 * let a reader set a replacement up from the work in front of them
 * ({@link file://./units/TextReplaceTools.tsx}). The two must agree exactly: a
 * selection the tools offer to replace and then couldn't have would be worse
 * than no offer at all.
 */

/**
 * Root of a work's own text. `#workskin` rather than `#chapters` because the
 * summary and the notes live in `.preface.group`, a *sibling* of `#chapters` —
 * walking only the chapters left the two blocks readers most often want
 * rewritten untouched. `#chapters` is the fallback for a page that renders it
 * without the skin wrapper.
 */
const WORK_TEXT_SELECTORS = ['#workskin', '#chapters']

/**
 * Subtrees inside the root that carry the work's *identity* rather than its
 * prose. The title and byline are what the work menu reads to name a work, and
 * what a work rule stores as its matched value — rewriting them would feed the
 * reader's replacements back into the extension's own data.
 */
const SKIP_SUBTREES = '.preface.group > h2.title.heading, .preface.group > h3.byline.heading'

/** Elements whose text is markup/controls, not prose — never rewrite inside these. */
const SKIP_PARENTS = /^(?:script|style|textarea)$/i

/** The work text on this page, or null if there is none. */
export function findWorkText(): Element | null {
  return WORK_TEXT_SELECTORS.reduce<Element | null>(
    (found, selector) => found ?? document.querySelector(selector),
    null,
  )
}

/** Whether an element's text is prose a replacement may rewrite. */
export function isReplaceableParent(parent: Element | null): boolean {
  if (!parent)
    return false
  if (SKIP_PARENTS.test(parent.tagName))
    return false
  return !parent.closest(SKIP_SUBTREES)
}

/** Whether a node sits in the part of `root` that replacements apply to. */
export function isInWorkText(node: Node | null, root: Element): boolean {
  if (!node)
    return false
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  if (!element || !root.contains(element))
    return false
  return isReplaceableParent(element)
}
