/**
 * Works by authors the reader muted on AO3. AO3 still sends them in a listing,
 * along with a stylesheet in the page's head whose one rule names a class per
 * muted user (`.user-123, .user-456 { display: none … }`) — the class each
 * blurb carries for each of its authors.
 *
 * Pure apart from {@link mutedBlurbSelector}, which reads the page it's handed;
 * nothing here imports `#common` or reaches for `browser`, so it loads under a
 * plain `node --test`.
 */

const USER_CLASS = /^\s*\.user-(\d+)\s*$/

/**
 * The user ids a rule with this selector names, when it is AO3's mute rule —
 * user classes and nothing else; none for any other rule.
 */
export function muteRuleIds(selector: string): string[] {
  const ids: string[] = []
  for (const part of selector.split(',')) {
    const id = USER_CLASS.exec(part)?.[1]
    if (!id)
      return []
    ids.push(id)
  }
  return ids
}

/**
 * A selector for the blurbs on `doc` by an author the reader muted, read off
 * AO3's mute stylesheet; null for a page without one, which is every page for a
 * reader who mutes nobody.
 */
export function mutedBlurbSelector(doc: Document): string | null {
  const ids = new Set<string>()
  for (const style of doc.querySelectorAll('style')) {
    for (const rule of style.sheet?.cssRules ?? []) {
      const { selectorText, style: declared } = rule as Partial<CSSStyleRule>
      if (!selectorText || declared?.display !== 'none')
        continue
      for (const id of muteRuleIds(selectorText))
        ids.add(id)
    }
  }
  return ids.size ? [...ids].map(id => `li.blurb.user-${id}`).join(', ') : null
}
