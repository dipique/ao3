<script setup lang="ts">
/**
 * The cache read-out and its purge, under the list of lists — in the shape of
 * the "Approximately X kB in use" line in
 * {@link file://../option_rows/OptionRowImportExport.vue}.
 *
 * Work text dwarfs everything else the extension stores, so this is part of
 * shipping the feature rather than polish. Deleting it costs
 * nothing but the hours of AO3 requests it would take to fetch again, which is
 * why the button asks a second time rather than opening a dialog.
 */
const { usage, status, purge } = useSiteExport()

const subtitle = computed(() => {
  if (!usage.value.cached)
    return 'No work text is cached yet. Caching a list stores each work on this device so the exported site can be read offline.'
  const failed = usage.value.failed
    ? ` ${usage.value.failed.toLocaleString()} could not be fetched and will be retried.`
    : ''
  return `${usage.value.cached.toLocaleString()} works cached, using about ${formatBytes(usage.value.bytes)}.${failed}`
    + ' Stored on this device only, and never synced or included in a settings export.'
})

/** Resets itself, so a confirmation left on screen can't be clicked into later. */
const confirming = autoResetRef(false, 5000)

async function onClick(): Promise<void> {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  await purge()
}
</script>

<template>
  <OptionRow title="Cached work text" :subtitle="subtitle">
    <Button
      :variant="confirming ? 'destructive' : 'outline'"
      class="disabled:cursor-default disabled:op-50"
      :disabled="!usage.cached || status.running"
      @click.prevent="onClick"
    >
      {{ confirming ? 'Delete it all?' : 'Delete cached text' }}
    </Button>
  </OptionRow>
</template>
