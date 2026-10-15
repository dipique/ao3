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
