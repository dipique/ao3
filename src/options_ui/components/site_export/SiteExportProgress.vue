<script setup lang="ts">
/**
 * The job's line, under the row it belongs to: what it is doing, a bar, why it
 * stopped, what it warns of, and the per-work failures behind a count — a list
 * of forty restricted works is not what a reader wants to scroll past every
 * time they open the page.
 *
 * A pause in requests says which kind it is, since the two mean opposite
 * things: pacing is the extension being polite (muted, an hourglass), a refusal
 * is AO3 complaining (the warning colour, its own glyph, a striped bar).
 *
 * Rendered only by the row that owns the job; it reads the one job directly
 * rather than taking it as a prop.
 */
const { view } = useSiteExport()

/** A state with a glyph of its own; the others take their severity's. */
const glyph = computed(() => {
  const { state, wait, error } = view.value
  if (state === 'waiting' && wait === 'pacing')
    return 'i-tabler-hourglass'
  if (state === 'stopped' && !error)
    return 'i-tabler-player-pause'
  return undefined
})

const percent = computed(() => {
  const { done, total } = view.value
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
})

/** The bar moves in the brand colour, stripes while AO3 refuses us, and freezes grey once the job stops. */
const bar = computed(() => {
  const { state, wait } = view.value
  if (state === 'stopped' || state === 'finished')
    return 'bg-muted-fg'
  return wait === 'refused' ? 'job-bar-refused' : 'bg-brand-fg'
})

const showErrors = ref(false)
</script>

<template>
  <div
    v-if="view.state !== 'idle'"
    :data-job-state="view.state"
    :data-job-wait="view.wait"
    flex="~ col gap-2" pb-2 pt-1
  >
    <div flex="~ row items-center gap-2" min-w-0 text-sm>
      <Icon
        v-if="!view.severity"
        i-tabler-loader-2 shrink-0 text-brand-fg motion-safe:animate-spin
      />
      <SeverityGlyph v-else :severity="view.severity" :glyph="glyph" shrink-0 />
      <span min-w-0 flex-1 truncate :class="view.wait === 'pacing' ? 'text-muted-fg' : ''">
        <b v-if="view.wait === 'refused'" font-bold>{{ view.line }}</b>
        <template v-else>{{ view.line }}</template>
        <template v-if="view.countdown"> — trying again in {{ view.countdown }}</template>
      </span>
      <span v-if="view.total" ws-nowrap text="xs muted-fg" tabular-nums>
        {{ view.done.toLocaleString() }} / {{ view.total.toLocaleString() }}
      </span>
    </div>
    <div
      v-if="view.total"
      role="progressbar"
      :aria-label="view.label"
      aria-valuemin="0"
      :aria-valuemax="view.total"
      :aria-valuenow="view.done"
      h-1.5 w-full overflow-hidden rounded-full bg-input
    >
      <div h-full rounded-full transition-all :class="bar" :style="{ width: `${percent}%` }" />
    </div>

    <Callout v-if="view.error" severity="destructive">
      <p>{{ view.error }}</p>
    </Callout>

    <Callout v-for="warning in view.warnings" :key="warning" severity="warning">
      <p>{{ warning }}</p>
    </Callout>

    <div v-if="view.failures.shown.length" flex="~ col gap-1">
      <Button variant="link" self-start p-0 :aria-expanded="showErrors" @click.prevent="showErrors = !showErrors">
        {{ (view.failures.shown.length + view.failures.more).toLocaleString() }}
        {{ view.failures.shown.length + view.failures.more === 1 ? 'work' : 'works' }} could not be fetched
        <Icon :class="showErrors ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" ml-1 />
      </Button>
      <ul v-if="showErrors" flex="~ col gap-1" max-h-64 overflow-y-auto text-sm>
        <li v-for="failure in view.failures.shown" :key="failure.workId" flex="~ col">
          <ArchiveLink :path="`/works/${failure.workId}`">
            {{ failure.title || `Work ${failure.workId}` }}
          </ArchiveLink>
          <span text="xs muted-fg">{{ failure.reason }}</span>
        </li>
        <li v-if="view.failures.more" text="xs muted-fg">
          …and {{ view.failures.more.toLocaleString() }} more.
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.job-bar-refused {
  background: repeating-linear-gradient(
    -45deg,
    rgb(var(--color-brand-fg)) 0 5px,
    color-mix(in srgb, rgb(var(--color-brand-fg)) 45%, rgb(var(--color-default))) 5px 10px
  );
}
</style>
