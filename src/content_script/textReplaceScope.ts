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

/**
 * Elements that end a run of continuous text. A rule allowed to match across
 * formatting may read through `<em>`, `<a>` and the like — that's the point —
 * but never across one of these, so it can't join the end of one paragraph to
 * the start of the next.
 *
 * A fixed list rather than `getComputedStyle`: this is asked once per element of
 * a work's text, and a full style resolution per element makes a long work
 * noticeably slow to load. Works are user-written HTML, but AO3 sanitises it
 * down to a small vocabulary, all of which is here.
 */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'caption',
  'center',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])

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

/**
 * The work's text nodes, gathered into the runs of continuous reading they form:
 * one run per paragraph (or list item, or table cell), holding every text node
 * inside it in reading order however the markup breaks them up.
 *
 * A run is what a rule is matched against — see `replaceTextSegments` — so where
 * the runs are cut is exactly where no rule may reach, whatever it asks for. A
 * subtree we never rewrite (a script, the work's own title) ends a run too: it
 * is a hole in the text, not a seam to read across.
 */
export function collectTextRuns(root: Element): Text[][] {
  const runs: Text[][] = []
  let run: Text[] = []

  const flush = (): void => {
    if (run.length)
      runs.push(run)
    run = []
  }

  const visit = (parent: Node): void => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child as Text)
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE)
        continue

      const el = child as Element
      if (!isReplaceableParent(el)) {
        flush()
        continue
      }
      // A void block (`<br>`) has nothing to descend into, and still cuts.
      const block = BLOCK_TAGS.has(el.tagName.toLowerCase())
      if (block)
        flush()
      visit(el)
      if (block)
        flush()
    }
  }

  visit(root)
  flush()

  // A run of nothing but whitespace has nothing any rule could match.
  return runs.filter(nodes => nodes.some(node => (node.nodeValue ?? '').trim()))
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
