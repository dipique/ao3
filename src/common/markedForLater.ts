/**
 * What one write of the Marked for Later index changed, work by work: `true`
 * for a work that came onto it, `false` for one that went off. A tab reading
 * another tab's write learns from this which of the works it shows were saved
 * or cleared there.
 */
export function savedIndexChanges(before: ReadonlySet<string>, after: ReadonlySet<string>): Map<string, boolean> {
  const changes = new Map<string, boolean>()
  for (const id of after) {
    if (!before.has(id))
      changes.set(id, true)
  }
  for (const id of before) {
    if (!after.has(id))
      changes.set(id, false)
  }
  return changes
}

/**
 * Why a request to take a work off Marked for Later couldn't be made from an
 * AO3 tab, for a reader to act on: there was no AO3 page to make it from, or
 * none of them answered.
 */
export const NO_ARCHIVE_TAB = {
  none: 'the request has to come from an AO3 page — open AO3 in a tab and import this file again',
  silent: 'your AO3 tabs did not answer — reload one and import this file again',
} as const
