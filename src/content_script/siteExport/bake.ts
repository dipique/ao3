import type { TextReplacement } from '#common'

import { replaceTextSegments, textReplacementActive } from '#common'
import { collectTextRuns, findWorkText } from '#content_script/textReplaceScope.js'

/**
 * Bake the reader's find/replace rules into a cached work's text.
 *
 * The exported site has no extension in it, so nothing there runs
 * {@link file://../units/TextReplace.ts}: a work read on an iPad would come back
 * in AO3's words, not the reader's. Since the site is generated anyway, the
 * rewrite moves to generation time — same rules, same scope, same pure
 * `replaceTextSegments`, applied once into the HTML the site ships.
 *
 * **This runs on the way out, not on the way in.** The cache holds AO3's text as
 * fetched, and a work is only rewritten as it's written into an export. Baking
 * at fetch time would tie every cached work to the rules in force that day —
 * editing one rule would then mean re-fetching the entire library from AO3 to
 * pick it up, which is a great deal of traffic to spend on a find and replace
 * that needs no network at all. This way a rule change costs one re-export.
 *
 * The corollary, for whoever builds the site bundle: the work pages are already
 * rewritten, so the site must never apply the rules a second time.
 */

/**
 * The shape of `options.textReplacements` this needs — structural, so the option
 * object satisfies it as-is. `enabled` is honoured here rather than by the
 * caller: a switched-off feature that still rewrote an export would be a
 * genuinely baffling bug to find, from an iPad.
 */
export interface TextReplacementSettings {
  enabled: boolean
  rules: TextReplacement[]
}

/**
 * `html` (a cached work, as {@link file://./sanitize.ts} stored it) with every
 * active rule applied to the work's prose. Returned unchanged when there's
 * nothing to do — the feature is off, no rule is active, the HTML holds no work
 * text, or no rule actually matched.
 *
 * Only text nodes are touched, and only inside the same subtree the on-page unit
 * rewrites: the summary, the notes and the chapters, never the title, the byline
 * or the meta block. So a work reads on the site exactly as it reads on AO3 with
 * the extension running — including the parts the extension deliberately leaves
 * alone, which is what keeps a work's own identity in the export matching the
 * one the reader's rules and marks are keyed to.
 */
export function bakeTextReplacements(html: string, settings: TextReplacementSettings): string {
  if (!settings.enabled)
    return html

  // The whole list, inert entries included: `TextSpan.rule` indexes it, exactly
  // as it does on the page.
  const rules = settings.rules
  if (!rules.some(textReplacementActive))
    return html

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const root = findWorkText(doc)
  if (!root)
    return html

  let changed = false
  // Collected up front for the same reason the unit does it: rewriting mid-walk
  // would have the walk stepping through nodes it had just written.
  for (const nodes of collectTextRuns(root)) {
    const spans = replaceTextSegments(nodes.map(node => node.nodeValue ?? ''), rules)
    if (spans.every(span => span.rule === null))
      continue

    for (const [index, node] of nodes.entries()) {
      // A node's share is every span that came from it — the empty share
      // included, which is what a node whose words were swallowed by a match
      // beginning in the node before it gets.
      const next = spans.filter(span => span.segment === index).map(span => span.text).join('')
      if (next !== node.nodeValue) {
        node.nodeValue = next
        changed = true
      }
    }
  }

  // Unchanged text goes back byte for byte rather than through a reserialization
  // that would differ from what the cache holds for no reason anyone could see.
  return changed ? doc.body.innerHTML : html
}
