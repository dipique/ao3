<script setup lang="ts">
/**
 * The cache read-out and its two deletions, under the list of lists — in the
 * shape of the "~X kB in use" line in
 * {@link file://../option_rows/OptionRowImportExport.vue}.
 *
 * Work text dwarfs everything else the extension stores, so this is part of
 * shipping the feature rather than polish. Deleting it costs
 * nothing but the hours of AO3 requests it would take to fetch again, which is
 * why the buttons ask a second time in place rather than opening a dialog
 * ({@link file://../../composables/useConfirmInPlace.ts}).
 *
 * **Two deletions, because the cache outlives the lists on purpose.** Text is
 * keyed by work rather than by list, so forgetting a list leaves its works
 * behind for whichever other list might want them — and when none does, they sit
 * there with nothing pointing at them and no way out short of deleting the lot.
 * *Discard orphans* is that way out, and it says how much it would take before
 * it is pressed, which is the whole difference between the two buttons: one is
 * measurable in advance, the other is everything. Blurbs are stored by work as
 * well, and strand the same way, so the one button takes both.
 */
const { usage, orphans, status, purge, discardOrphans } = useSiteExport()

/**
 * What no list holds any more, said only when there is some — and said in terms
 * of text where there is text, since a leftover entry for a work that never
 * fetched is worth clearing but not worth a byte count.
 */
const stranded = computed(() => {
  const { cached, bytes, works, blurbs, blurbBytes } = orphans.value
  const parts: string[] = []
  if (cached)
    parts.push(`${cached.toLocaleString()} (~${formatBytes(bytes)}) orphaned work text(s)`)
  else if (works)
    parts.push(`${works.toLocaleString()} orphaned work text entr${works === 1 ? 'y' : 'ies'}`)
  if (blurbs)
    parts.push(`${blurbs.toLocaleString()} (~${formatBytes(blurbBytes)}) orphaned blurb(s)`)
  return parts.length ? ` ${parts.join(' and ')}.` : ''
})

/** Everything "Discard orphans" would take, counted the way its confirmation says. */
const orphanCount = computed(() => orphans.value.works + orphans.value.blurbs)

const subtitle = computed(() => {
  if (!usage.value.cached)
    return `No work text cached yet for offline reading.${stranded.value}`
  const failed = usage.value.failed
    ? ` ${usage.value.failed.toLocaleString()} could not be fetched and will be retried.`
    : ''
  // The two conditional halves are sentences of their own, after the parenthesis
  // rather than inside it — nested, the orphan line reads as part of the size.
  return `${usage.value.cached.toLocaleString()} works (${formatBytes(usage.value.bytes)}) cached.${failed}${stranded.value}`
})

const confirm = useConfirmInPlace()
const DISCARD = 'site-export-cache-discard-orphans'
const DELETE = 'site-export-cache-delete-all'

async function press(id: typeof DISCARD | typeof DELETE): Promise<void> {
  if (confirm.press(id))
    await (id === DISCARD ? discardOrphans() : purge())
}
</script>

<template>
  <OptionRow title="Cached work text" :subtitle="subtitle">
    <div flex="~ row wrap items-center justify-end gap-2">
      <Button
        :variant="confirm.armed(DISCARD) ? 'destructive' : 'outline'"
        class="disabled:cursor-default disabled:op-50"
        :disabled="!orphanCount || status.running"
        @click.prevent="press(DISCARD)"
      >
        {{ confirm.armed(DISCARD) ? `Discard ${orphanCount.toLocaleString()}?` : 'Discard orphans' }}
      </Button>
      <Button
        :variant="confirm.armed(DELETE) ? 'destructive' : 'outline'"
        class="disabled:cursor-default disabled:op-50"
        :disabled="!usage.cached || status.running"
        @click.prevent="press(DELETE)"
      >
        {{ confirm.armed(DELETE) ? 'Delete it all?' : 'Delete cached text' }}
      </Button>
    </div>
  </OptionRow>
</template>
