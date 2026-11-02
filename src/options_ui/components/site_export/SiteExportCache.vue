<script setup lang="ts">
import { ALL_CACHED } from '#content_script/siteExport/payload.js'

import { formatBytes } from '../../model/buckets.ts'
import { cachedTextOff, listJob } from '../../model/jobView.ts'
import { sentence, withReason } from '../../model/phrases.ts'

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
 *
 * Both are off while a job runs, since it is writing the text they would
 * delete, and each then says so.
 *
 * Beside them, *Download all cached* writes every cached work into one offline
 * copy, whichever list it came from, asking AO3 for nothing. It is a job like a
 * list's download, so it waits its turn behind any other and draws its line
 * under the row.
 */
const { usage, orphans, view, purge, discardOrphans, downloadAllCached, resume, discard, cancel } = useSiteExport()

/** The download of every cached work as the job sees it: what the row offers, why it is off, and whether the job's line is the row's. */
const allJob = computed(() => listJob(view.value, ALL_CACHED))
const downloadOff = computed(() => (usage.value.cached ? allJob.value.off : null))
const downloadOffId = useId()

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

/** Why the job keeps both buttons off, said only on a button that would otherwise be on. */
const jobOff = computed(() => cachedTextOff(view.value))
const discardOff = computed(() => (orphanCount.value ? jobOff.value : null))
const deleteOff = computed(() => (usage.value.cached ? jobOff.value : null))
const jobOffId = useId()

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
      <button
        v-if="allJob.actions === 'stop'"
        type="button"
        class="outline-btn"
        data-action="cancel"
        @click="cancel()"
      >
        <span class="i-tabler-x" aria-hidden="true" />
        Cancel
      </button>
      <button
        v-else
        type="button"
        class="outline-btn"
        :title="downloadOff ? withReason('Download all cached', downloadOff) : undefined"
        :aria-describedby="downloadOff ? downloadOffId : undefined"
        :disabled="!usage.cached || !!downloadOff"
        data-action="download-all-cached"
        @click="downloadAllCached()"
      >
        <span class="i-tabler-download" aria-hidden="true" />
        Download all cached
      </button>
      <span v-if="downloadOff" :id="downloadOffId" hidden>{{ sentence(downloadOff) }}.</span>
      <button
        type="button"
        :class="confirm.armed(DISCARD) ? 'armed-btn' : 'outline-btn'"
        :title="discardOff ? withReason('Discard orphans', discardOff) : undefined"
        :aria-describedby="discardOff ? jobOffId : undefined"
        :disabled="!orphanCount || !!jobOff"
        data-action="discard-orphans"
        :data-armed="confirm.armed(DISCARD) || undefined"
        @click.prevent="press(DISCARD)"
      >
        {{ confirm.armed(DISCARD) ? `Discard ${orphanCount.toLocaleString()}?` : 'Discard orphans' }}
      </button>
      <button
        type="button"
        :class="confirm.armed(DELETE) ? 'armed-btn' : 'outline-btn'"
        :title="deleteOff ? withReason('Delete cached text', deleteOff) : undefined"
        :aria-describedby="deleteOff ? jobOffId : undefined"
        :disabled="!usage.cached || !!jobOff"
        data-action="delete-cached"
        :data-armed="confirm.armed(DELETE) || undefined"
        @click.prevent="press(DELETE)"
      >
        {{ confirm.armed(DELETE) ? 'Delete it all?' : 'Delete cached text' }}
      </button>
      <span v-if="jobOff" :id="jobOffId" hidden>{{ sentence(jobOff) }}.</span>
    </div>
    <template v-if="allJob.here" #extra>
      <SiteExportProgress>
        <template v-if="allJob.actions === 'resume'" #foot>
          <button type="button" class="primary-btn small-btn" data-action="resume" @click="resume()">
            <span class="i-tabler-player-play" aria-hidden="true" />
            Continue
          </button>
          <button type="button" class="ghost-btn small-btn" data-action="discard" @click="discard()">
            Discard
          </button>
        </template>
      </SiteExportProgress>
    </template>
  </OptionRow>
</template>
