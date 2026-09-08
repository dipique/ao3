<script setup lang="ts">
/**
 * The cache read-out and its two deletions, under the list of lists — in the
 * shape of the "Approximately X kB in use" line in
 * {@link file://../option_rows/OptionRowImportExport.vue}.
 *
 * Work text dwarfs everything else the extension stores, so this is part of
 * shipping the feature rather than polish. Deleting it costs
 * nothing but the hours of AO3 requests it would take to fetch again, which is
 * why the buttons ask a second time rather than opening a dialog.
 *
 * **Two deletions, because the cache outlives the lists on purpose.** Text is
 * keyed by work rather than by list, so forgetting a list leaves its works
 * behind for whichever other list might want them — and when none does, they sit
 * there with nothing pointing at them and no way out short of deleting the lot.
 * *Discard orphans* is that way out, and it says how much it would take before
 * it is pressed, which is the whole difference between the two buttons: one is
 * measurable in advance, the other is everything.
 */
const { usage, orphans, status, purge, discardOrphans } = useSiteExport()

/**
 * What no list holds any more, said only when there is some — and said in terms
 * of text where there is text, since a leftover entry for a work that never
 * fetched is worth clearing but not worth a byte count.
 */
const stranded = computed(() => {
  if (orphans.value.cached) {
    return ` ${orphans.value.cached.toLocaleString()} of them (about ${formatBytes(orphans.value.bytes)})`
      + ' belong to no stored list and can be discarded.'
  }
  if (orphans.value.works)
    return ` ${orphans.value.works.toLocaleString()} failed entries belong to no stored list.`
  return ''
})

const subtitle = computed(() => {
  if (!usage.value.cached)
    return 'No work text is cached yet. Caching a list stores each work on this device so the exported site can be read offline.'
  const failed = usage.value.failed
    ? ` ${usage.value.failed.toLocaleString()} could not be fetched and will be retried.`
    : ''
  return `${usage.value.cached.toLocaleString()} works cached, using about ${formatBytes(usage.value.bytes)}.${failed}${stranded.value}`
    + ' Stored on this device only, and never synced or included in a settings export.'
})

/**
 * Which button is one press from doing something, at most one at a time — a
 * confirmation left standing over the wrong button is exactly how the wrong
 * thing gets deleted. Resets itself, so one left on screen can't be clicked into
 * later either.
 */
const confirming = autoResetRef<'orphans' | 'all' | null>(null, 5000)

async function press(which: 'orphans' | 'all'): Promise<void> {
  if (confirming.value !== which) {
    confirming.value = which
    return
  }
  confirming.value = null
  await (which === 'orphans' ? discardOrphans() : purge())
}
</script>

<template>
  <OptionRow title="Cached work text" :subtitle="subtitle">
    <div flex="~ row items-center gap-2">
      <Button
        :variant="confirming === 'orphans' ? 'destructive' : 'outline'"
        class="disabled:cursor-default disabled:op-50"
        :disabled="!orphans.works || status.running"
        @click.prevent="press('orphans')"
      >
        {{ confirming === 'orphans' ? `Discard ${orphans.works.toLocaleString()}?` : 'Discard orphans' }}
      </Button>
      <Button
        :variant="confirming === 'all' ? 'destructive' : 'outline'"
        class="disabled:cursor-default disabled:op-50"
        :disabled="!usage.cached || status.running"
        @click.prevent="press('all')"
      >
        {{ confirming === 'all' ? 'Delete it all?' : 'Delete cached text' }}
      </Button>
    </div>
  </OptionRow>
</template>
