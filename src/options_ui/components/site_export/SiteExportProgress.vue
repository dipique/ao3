<script setup lang="ts">
/**
 * The running (or last) job's progress, under the row it belongs to: a bar, the
 * work being fetched, whatever stopped it, and the per-work failures behind a
 * count — a list of forty restricted works is not what a reader wants to scroll
 * past every time they open Advanced.
 *
 * Rendered only by the row that owns the job; it reads the runner's status
 * directly rather than taking it as a prop, since there is only ever one.
 */
const { status } = useSiteExport()

const job = computed(() => status.value.job)

const percent = computed(() => {
  const total = job.value?.total ?? 0
  return total > 0 ? Math.min(100, Math.round(((job.value?.done ?? 0) / total) * 100)) : 0
})

/** What the line says when the runner has nothing more specific to report. */
const state = computed(() => {
  if (status.value.running)
    return 'Working…'
  // No steps left and nothing waiting: the job ran out of things to do rather
  // than being interrupted, which is a different thing to tell the reader.
  return job.value && !job.value.steps.length && !job.value.blocked ? 'Finished' : 'Stopped'
})

/**
 * A clock, ticking only while there is something to count down to.
 *
 * The runner reports *when* it may next ask AO3 for something rather than how
 * long that is, so this is the half that turns a deadline into a number a reader
 * can watch go down. A permanent interval on the options page would be a poor
 * trade for a line that is usually absent, hence the watch.
 */
const now = ref(Date.now())
watchEffect((onCleanup) => {
  if (!status.value.waitingUntil)
    return
  now.value = Date.now()
  const timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  onCleanup(() => clearInterval(timer))
})

const waitLeft = computed(() => Math.max(0, (status.value.waitingUntil ?? 0) - now.value))

/** `2:05`, or `9s` under a minute — a wait too short to need the colon. */
function countdown(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const seconds = total % 60
  return total >= 60 ? `${Math.floor(total / 60)}:${String(seconds).padStart(2, '0')}` : `${seconds}s`
}

/**
 * The one line the progress panel shows: what the run is doing, plus how long
 * until it does anything, when it is being made to wait.
 */
const line = computed(() => {
  const base = status.value.message || state.value
  return waitLeft.value > 0 ? `${base} — trying again in ${countdown(waitLeft.value)}` : base
})

const showErrors = ref(false)
</script>

<template>
  <div v-if="job" flex="~ col gap-2" pb-2 pt-1>
    <div v-if="job.total" flex="~ col gap-1">
      <div flex="~ row items-center justify-between gap-3" text="sm muted-fg">
        <span truncate>{{ line }}</span>
        <span ws-nowrap>{{ job.done.toLocaleString() }} / {{ job.total.toLocaleString() }}</span>
      </div>
      <div h-2 w-full overflow-hidden rounded-full bg-input>
        <div h-full rounded-full bg-primary transition-all :style="{ width: `${percent}%` }" />
      </div>
    </div>
    <p v-else-if="status.message" text="sm muted-fg">
      {{ line }}
    </p>

    <p v-if="status.error" text="sm" :style="{ color: '#dc2626' }">
      {{ status.error }}
    </p>

    <p v-for="warning in status.warnings" :key="warning" text="sm" :style="{ color: '#d97706' }">
      {{ warning }}
    </p>

    <div v-if="job.errorCount" flex="~ col gap-1">
      <Button variant="link" self-start p-0 @click.prevent="showErrors = !showErrors">
        {{ job.errorCount.toLocaleString() }} {{ job.errorCount === 1 ? 'work' : 'works' }} could not be fetched
        <Icon :class="showErrors ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" ml-1 />
      </Button>
      <ul v-if="showErrors" flex="~ col gap-1" max-h-64 overflow-y-auto text-sm>
        <li v-for="failure in job.errors" :key="failure.workId" flex="~ col">
          <ArchiveLink :path="`/works/${failure.workId}`">
            {{ failure.title || `Work ${failure.workId}` }}
          </ArchiveLink>
          <span text="xs muted-fg">{{ failure.reason }}</span>
        </li>
        <li v-if="job.errorCount > job.errors.length" text="xs muted-fg">
          …and {{ (job.errorCount - job.errors.length).toLocaleString() }} more.
        </li>
      </ul>
    </div>
  </div>
</template>
