<script setup lang="ts">
import type { Day } from '#common'

import { getArchiveLink, isoDay, readSummary, utcToday } from '#common'
import { onReadRecordsChanged, readStoredRecords } from '#content_script/tracked/readStore.ts'

import { sentence, withReason } from '../../model/phrases.ts'
import { latestReviewable, recordsLine, REVIEW_NAME, reviewBlock, reviewedThroughFrom, reviewedThroughLabel, WORKS_PER_REVIEW } from '../../model/review.ts'

/**
 * Tracked lists, and what shapes the review they are gathered into: how far
 * the reader has been, how many works a range aims for, and This review, the
 * range being reviewed now, which is stored like a list so that it can be
 * cached and downloaded. The lists themselves are under Saved lists.
 *
 * The cells show whether the switch is on or off: the review's window keeps
 * its offline copy either way, so caching and downloading it stay on, while
 * what only the review uses is off and says why.
 */
const { enabled, target, reviewedThrough, lists } = useOption('trackedLists')
const { review, userId, view: job, cacheWorks, downloadSite, preloadReview, stop, cancel, resume, discard } = useSiteExport()
const now = useNow({ interval: 60_000 })

const block = computed(() => reviewBlock({
  enabled: enabled.value,
  tracking: lists.value.some(list => list.tracked),
  window: review.value && {
    key: review.value.key,
    count: review.value.count,
    buckets: review.value.buckets,
    scrapedAt: review.value.scrapedAt,
    listUrl: review.value.listUrl,
  },
  userId: userId.value,
  job: job.value,
  now: now.value.getTime(),
}))

const settingsOffId = useId()
const offlineOffId = useId()
const startOffId = useId()

// ---------------------------------------------------------------------------
// Reviewed through
// ---------------------------------------------------------------------------

/**
 * The watermark is the whole review state, so editing it is the escape hatch for
 * both mistakes: rewinding a range marked reviewed too soon, and skipping a
 * backlog nobody is going to read. It's a day rather than a work, which is why
 * one date field covers both.
 */
const changingDate = ref(false)
const dateDraft = ref('')
const dateInput = useTemplateRef<HTMLInputElement>('dateInput')
const changeButton = useTemplateRef<HTMLButtonElement>('changeButton')

async function startChange(): Promise<void> {
  dateDraft.value = reviewedThrough.value > 0 ? isoDay(reviewedThrough.value) : ''
  changingDate.value = true
  await nextTick()
  dateInput.value?.focus()
}

async function endChange(): Promise<void> {
  changingDate.value = false
  await nextTick()
  changeButton.value?.focus()
}

/** A date half typed into the picker writes nothing, and leaves the field open. */
function commitDate(): void {
  const day = reviewedThroughFrom(dateDraft.value, utcToday())
  if (day === null)
    return
  reviewedThrough.value = day
  void endChange()
}

watch(enabled, (on) => {
  if (!on)
    changingDate.value = false
})

// ---------------------------------------------------------------------------
// This review
// ---------------------------------------------------------------------------

const cacheLabel = computed(() => (review.value?.cached ? 'Update the cached works' : 'Cache this list\'s works'))
const downloadLabel = 'Cache this list\'s works, then save it as one HTML file'

function cache(): void {
  if (review.value)
    void cacheWorks(review.value)
}

function download(): void {
  if (review.value)
    void downloadSite(review.value)
}

// ---------------------------------------------------------------------------
// Pre-load, and how far the lists are read
// ---------------------------------------------------------------------------

const preloadLabel = 'Read your tracked lists from AO3 now, so the next review opens without waiting on it'

/** Pre-load's reason for being off is said where Start Review's or the offline actions' is. */
const preloadOffId = computed(() => {
  const off = block.value.preload.off
  if (!off)
    return undefined
  return off === block.value.offlineOff ? offlineOffId : startOffId
})

function preload(): void {
  void preloadReview()
}

/** What the tracked lists' read records say: refreshed whenever one is written, here or on AO3. */
const records = ref<{ through: Day | null, behind: number }>({ through: null, behind: 0 })
const recordsText = computed(() => recordsLine(records.value))

async function readRecordsLine(): Promise<void> {
  const tracked = lists.value.filter(list => list.tracked)
  const summary = readSummary(tracked, await readStoredRecords(tracked.map(list => list.id)))
  records.value = { through: summary.through, behind: summary.behind.length }
}

let stopRecords: (() => void) | null = null
onMounted(() => {
  void readRecordsLine()
  stopRecords = onReadRecordsChanged(() => void readRecordsLine())
})
onBeforeUnmount(() => stopRecords?.())
watch(lists, () => void readRecordsLine(), { deep: true })
</script>

<template>
  <OptionRow
    title="Tracked lists"
    subtitle="Mark a search, an uncommon tag's works or a series as tracked, and everything new or updated across all of them is gathered into one review stream on your readings page. You look through a range of days, mark what deserves marking, then mark the range reviewed."
  >
    <template #default="{ id }">
      <Switch :id="id" v-model="enabled" />
    </template>

    <template #extra>
      <OptionRowInset>
        <div class="review">
          <div class="review__grid">
            <ReviewCell cell="reviewed-through" head="Reviewed through" :dim="!!block.settingsOff">
              <div v-if="!changingDate" class="review__line">
                <span class="review__value">{{ reviewedThroughLabel(reviewedThrough) }}</span>
                <button
                  ref="changeButton"
                  type="button"
                  class="outline-btn small-btn"
                  :title="withReason('Change the last day reviewed', block.settingsOff)"
                  :disabled="!!block.settingsOff"
                  :aria-describedby="block.settingsOff ? settingsOffId : undefined"
                  @click="startChange"
                >
                  Change…
                </button>
              </div>
              <div v-else class="review__line review__line--edit">
                <input
                  ref="dateInput"
                  v-model="dateDraft"
                  type="date"
                  :max="latestReviewable(utcToday())"
                  aria-label="Last day marked reviewed"
                  class="review__date input-ring"
                  @change="commitDate"
                >
                <button type="button" class="outline-btn" @click="commitDate">
                  Save
                </button>
                <button type="button" class="ghost-btn" @click="endChange">
                  Cancel
                </button>
              </div>
              <template #help>
                The next review starts the day after. Move it back to review a range again, or forward to write off a
                backlog you are never going to read. Clearing it starts from the day your earliest list was tracked.
              </template>
            </ReviewCell>

            <ReviewCell cell="works-per-review" head="Works per review" :dim="!!block.settingsOff">
              <div class="review__line">
                <Stepper
                  v-model="target"
                  :min="WORKS_PER_REVIEW.min"
                  :max="WORKS_PER_REVIEW.max"
                  size="row"
                  label="Works per review"
                  decrement-label="Fewer works per review"
                  increment-label="More works per review"
                  :off="block.settingsOff"
                />
                <span class="review__unit">works</span>
              </div>
              <template #help>
                A range takes whole days until one more day would push it past this, so it is a target rather than a
                limit. {{ WORKS_PER_REVIEW.min }}–{{ WORKS_PER_REVIEW.max }}.
              </template>
            </ReviewCell>

            <ReviewCell cell="this-review" head="This review" :job="block.actions === 'stop'">
              <div v-if="block.figure" class="review__line">
                <span class="review__value">{{ block.figure.count }}</span>
                <span class="review__detail">{{ block.figure.detail }}</span>
              </div>
              <p v-else class="review__empty">
                {{ block.empty }}
              </p>
              <p v-if="recordsText" class="review__detail review__records" data-review-records>
                {{ recordsText }}
              </p>

              <!-- Said where the reader is looking, beside the buttons it turns off. -->
              <p v-if="block.offlineOff" class="review__note">
                <SeverityGlyph severity="neutral" shrink-0 />
                <span :id="offlineOffId">{{ sentence(block.offlineOff) }}.</span>
              </p>

              <SiteExportProgress v-if="block.job" />

              <div v-if="!block.actions" class="review__buttons">
                <button
                  type="button"
                  class="outline-btn small-btn"
                  :title="withReason(preloadLabel, block.preload.off)"
                  :disabled="!!block.preload.off"
                  :aria-describedby="preloadOffId"
                  @click="preload"
                >
                  <span class="i-tabler-refresh" aria-hidden="true" />
                  Pre-load
                </button>
              </div>
              <div v-if="block.actions" class="review__buttons">
                <template v-if="block.actions === 'offline'">
                  <button
                    type="button"
                    class="outline-btn small-btn"
                    :title="withReason(cacheLabel, block.offlineOff)"
                    :disabled="!!block.offlineOff"
                    :aria-describedby="block.offlineOff ? offlineOffId : undefined"
                    @click="cache"
                  >
                    <span class="i-tabler-cloud-download" aria-hidden="true" />
                    Cache works
                  </button>
                  <button
                    type="button"
                    class="outline-btn small-btn"
                    :title="withReason(downloadLabel, block.offlineOff)"
                    :disabled="!!block.offlineOff"
                    :aria-describedby="block.offlineOff ? offlineOffId : undefined"
                    @click="download"
                  >
                    <span class="i-tabler-download" aria-hidden="true" />
                    Download Offline Copy
                  </button>
                  <button
                    type="button"
                    class="outline-btn small-btn"
                    :title="withReason(preloadLabel, block.preload.off)"
                    :disabled="!!block.preload.off"
                    :aria-describedby="preloadOffId"
                    @click="preload"
                  >
                    <span class="i-tabler-refresh" aria-hidden="true" />
                    Pre-load
                  </button>
                  <span class="review__spacer" />
                  <OfflineMoreMenu
                    :name="REVIEW_NAME"
                    :row="review"
                    :retry="block.retry"
                    :cached="block.cached"
                    :off="block.offlineOff"
                    :off-id="offlineOffId"
                  />
                </template>
                <template v-else-if="block.actions === 'stop'">
                  <button type="button" class="outline-btn small-btn" @click="stop()">
                    <span class="i-tabler-player-pause" aria-hidden="true" />
                    Pause
                  </button>
                  <button type="button" class="outline-btn small-btn" @click="cancel()">
                    Cancel
                  </button>
                </template>
                <template v-else>
                  <button type="button" class="primary-btn small-btn" @click="resume()">
                    <span class="i-tabler-player-play" aria-hidden="true" />
                    Continue
                  </button>
                  <button type="button" class="ghost-btn small-btn" @click="discard()">
                    Discard
                  </button>
                </template>
              </div>

              <a
                v-if="block.start.href"
                :href="getArchiveLink(block.start.href)"
                target="_blank"
                rel="noopener noreferrer"
                class="review__start touch-target input-ring"
                :aria-label="block.start.label"
              >
                Start Review
                <span class="i-tabler-arrow-right" aria-hidden="true" />
              </a>
              <button
                v-else
                type="button"
                class="review__start touch-target input-ring"
                :title="withReason(block.start.label, block.start.off)"
                disabled
                :aria-describedby="startOffId"
              >
                Start Review
                <span class="i-tabler-arrow-right" aria-hidden="true" />
              </button>
              <span v-if="block.start.off" :id="startOffId" hidden>{{ sentence(block.start.off) }}.</span>
            </ReviewCell>
          </div>
          <span v-if="block.settingsOff" :id="settingsOffId" hidden>{{ sentence(block.settingsOff) }}.</span>
        </div>
      </OptionRowInset>
    </template>
  </OptionRow>
</template>

<style scoped>
/*
  Three cells side by side where the panel has the room, each over the others
  where it doesn't: a container query, so the cells stack on a narrow window
  and beside the rail on a middling one alike.
*/
.review {
  container-type: inline-size;
}
.review__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid rgb(var(--color-hair));
  border-radius: 9px;
  background-color: rgb(var(--color-default));
}
.review__grid > * + * {
  border-top: 1px solid rgb(var(--color-hair));
}
@container (min-width: 600px) {
  .review__grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .review__grid > * + * {
    border-top: none;
    border-left: 1px solid rgb(var(--color-hair));
  }
}

.review__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  min-height: 28px;
}
.review__line--edit {
  gap: 6px;
}
.review__value {
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
/* `--quiet-fg` is the cell's: muted, unless a job tints it. */
.review__detail,
.review__unit {
  color: var(--quiet-fg);
  font-size: 12px;
}
.review__records {
  margin: 0;
}
.review__empty {
  margin: 0;
  font-size: 12px;
  line-height: 17px;
}
.review__date {
  height: 28px;
  padding: 0 8px;
  border: 1px solid rgb(var(--color-input));
  border-radius: 7px;
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-default-fg));
  font: inherit;
  font-size: 12.5px;
}
.review__note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: var(--quiet-fg);
  font-size: 11.5px;
  line-height: 15px;
}
.review__buttons {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.review__spacer {
  flex: 1;
}
.review__start {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 40px;
  margin-top: 6px;
  border: 1px solid rgb(var(--color-primary));
  border-radius: 7px;
  background-color: rgb(var(--color-primary));
  color: rgb(var(--color-primary-fg));
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.review__start:hover:not(:disabled) {
  background-color: rgb(var(--color-primary) / 0.9);
  color: rgb(var(--color-primary-fg));
}
.review__start:disabled {
  cursor: default;
  opacity: 0.48;
}
</style>
