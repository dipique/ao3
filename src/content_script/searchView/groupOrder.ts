/**
 * Where the facet groups go as the reader moves one, by its arrows or by
 * dragging it. Pure, so the view only has to put the groups where it's told.
 */

/**
 * The facet order with `key` moved to slot `to` among the groups shown, a slot
 * past either end pulled back to it: the shown groups in their new order, then
 * the keys with no group on screen, in the order they had among themselves. A
 * key with no group shown changes nothing.
 */
export function moveGroupKey<K>(order: readonly K[], shown: readonly K[], key: K, to: number): K[] {
  if (!shown.includes(key))
    return [...order]
  const next = shown.filter(k => k !== key)
  next.splice(Math.min(Math.max(to, 0), next.length), 0, key)
  const onScreen = new Set(next)
  return [...next, ...order.filter(k => !onScreen.has(k))]
}

/**
 * The slot a dragged group belongs in, as an index among the groups shown: one
 * past each other group whose middle the pointer at `y` is below. `mids` are
 * the groups' middles in page order, the dragged group's own at `dragged`.
 * Moving the group there only pushes the others away from the pointer, so the
 * answer holds until the pointer crosses another middle.
 */
export function dropSlot(mids: readonly number[], dragged: number, y: number): number {
  let slot = 0
  for (const [i, mid] of mids.entries()) {
    if (i !== dragged && mid < y)
      slot++
  }
  return slot
}
