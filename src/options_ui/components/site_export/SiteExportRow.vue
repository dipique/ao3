<script setup lang="ts">
import type { SiteExportListRow } from '../../composables/useSiteExport.ts'

// Named rather than left to the auto-import: these are read from the template,
// and auto-imports only reach `<script setup>`.
import { canTrack, formatBytes, isReviewWindow, listName, NO_DESCRIPTOR_NOTE, REVIEW_WINDOW_NOTE, savedListFor } from '../../composables/useSiteExport.ts'
import { isRunning, offReason, removeOff } from '../../model/jobView.ts'
import { sentence, withReason } from '../../model/phrases.ts'
import { OFFLINE_OFF } from '../../model/savedListRows.ts'

/**
 * One stored works list, as a row in Advanced → Site export.
 *
 * The buttons are state-dependent rather than always-available, because the job
 * runner is a singleton: while any list is being fetched, every other row's
 * actions are off — two runs would only double the request rate AO3 is asked to
 * carry. Every control that is off says why, in its tooltip and its
 * description.
 *
 * They are also **deliberately terse**. A list's name is the only thing here the
 * reader can't reconstruct, and every pixel the buttons take is a pixel it
 * doesn't get — so what would read as "Refresh list" and "Cache works" is a
 * refresh cap and two words, with the long form kept as each button's tooltip
 * and accessible name.
 */
const props = defineProps<{ row: SiteExportListRow }>()

const {
  view,
  refreshList,
  cacheWorks,
  refreshAndCache,
  downloadSite,
  downloadCached,
  deleteList,
  stop,
  resume,
  discard,
  track,
} = useSiteExport()

/**
 * What to call this list. A saved list's title is the reader's own name for it
 * — the one the review's "List source" filter uses while it is tracked — so
 * once there is one, it is the name here too rather than a second name for the
 * same thing.
 */
const name = computed(() => listName(props.row))

/** Whether this stored list is a tracked list's. */
const tracked = computed(() => !!savedListFor(props.row)?.entry)

/** Offered only on a list that isn't tracked already — one entry per list. */
const trackable = computed(() => canTrack(props.row) && !tracked.value)

/** The tracked review's own window, which is not read from a listing. */
const review = computed(() => isReviewWindow(props.row))

/**
 * Whether there is a listing behind this row to walk at all — which is the
 * question of whether the refresh buttons belong here, and a different one from
 * whether they would work right now (no descriptor disables them, and the note
 * under the row says how to fix that). The review's window is gathered from
 * every tracked list at once, so refreshing it from here is meaningless work,
 * and its buttons are left out rather than sitting there offering it.
 */
const refreshable = computed(() => !review.value)

/** The job belongs to this list. Another list's job only turns this row's actions off. */
const mine = computed(() => view.value.key === props.row.key)
const running = computed(() => mine.value && isRunning(view.value))
/** A job of ours that stopped with work left — offer to carry on, not to restart. */
const paused = computed(() => mine.value && view.value.state === 'stopped')

/**
 * Why refreshing, caching and downloading are off: a list saved before the
 * extension could fetch it again, or the one job, running on another list.
 */
const offline = computed(() => (props.row.descriptor ? offReason(view.value, props.row.key) : OFFLINE_OFF.undescribed))
/** Another list's job, said under the row as well as on the buttons it turns off. */
const busyNote = computed(() => (props.row.descriptor && !running.value ? offline.value : null))
const offlineId = useId()

/** Why the trash is off: this list's own job is reading it. */
const removeReason = computed(() => removeOff(view.value, props.row.key))
const removeId = useId()

const refreshLabel = computed(() => `Refresh the list of works in ${name.value}`)

const cacheLabel = computed(() => (props.row.cached ? 'Update the cached works' : 'Cache this list\'s works'))

/** The menu has nothing in it for a list that can't be refreshed and hasn't failed. */
const hasMenu = computed(() => refreshable.value || props.row.failed > 0)

const downloadLabel = computed(() => (refreshable.value
  ? 'Refresh, cache, then save this list as one HTML file'
  : 'Cache this list\'s works, then save it as one HTML file'))

/** Deleting a list is cheap to undo only by re-scraping it, so it asks first. */
const confirmingDelete = ref(false)

async function remove(): Promise<void> {
  confirmingDelete.value = false
  await deleteList(props.row)
}

/** Off, disabled, and not pretending otherwise. */
const OFF = 'disabled:cursor-default disabled:op-50'
/**
 * One-word buttons are narrow enough that the default padding is most of them,
 * and every pixel here comes out of the list's name and figures beside it.
 */
const TIGHT = `${OFF} !px-3`
/**
 * A run of buttons that reads as one control: square corners inside, rounded
 * ends, and each border pulled onto its neighbour's so the seam is one line
 * rather than two. Important, because `btn` rounds every corner it owns and a
 * plain override only wins by stylesheet order.
 */
const JOINED = `${TIGHT} !rounded-none -ml-px`
const JOINED_END = `${OFF} !rounded-l-none -ml-px`
</script>

<template>
  <OptionRow :title="name" :subtitle="row.summary" stacked control-width="24rem" :data-list-row="row.key">
    <!--
      Where the list actually is. A row can be refreshed from here only after the
      view has scraped it once, so "go and open it" is a real instruction — and
      one worth making a click rather than a search.
    -->
    <template #title-suffix>
      <ArchiveLink
        v-if="row.listUrl"
        :href="row.listUrl"
        :aria-label="`Open ${name} on AO3`"
        text-sm
      >
        (link)
      </ArchiveLink>
    </template>

    <div flex="~ row items-center gap-2">
      <Button v-if="running" variant="outline" :class="OFF" @click.prevent="stop()">
        Stop
      </Button>

      <template v-else-if="paused">
        <Button @click.prevent="resume()">
          Continue
        </Button>
        <Button variant="ghost" @click.prevent="discard()">
          Discard
        </Button>
      </template>

      <template v-else>
        <!--
          Refresh: the list, the works, or the menu. The cap is the verb and is
          not a button — there is nothing sensible for "refresh, unspecified" to
          do — so each button below carries the whole phrase as its own label.

          A list with no listing behind it (the tracked review's window) keeps
          only the half that is about the works, and loses the cap with the half
          that is about the listing.
        -->
        <div flex="~ row items-center">
          <template v-if="refreshable">
            <div
              aria-hidden="true"
              flex="~ items-center justify-center"
              h-10 w-10 border-1 border-input rounded-l-md bg-default text-muted-fg
            >
              <Icon i-mdi-refresh />
            </div>
            <Button
              variant="outline"
              :class="JOINED"
              :title="withReason(refreshLabel, offline)"
              :aria-describedby="offline ? offlineId : undefined"
              :disabled="!!offline"
              @click.prevent="refreshList(row)"
            >
              List
            </Button>
          </template>
          <Button
            variant="outline"
            :class="refreshable ? JOINED : (hasMenu ? `${TIGHT} !rounded-r-none` : TIGHT)"
            :title="withReason(cacheLabel, offline)"
            :aria-describedby="offline ? offlineId : undefined"
            :disabled="!!offline"
            @click.prevent="cacheWorks(row)"
          >
            Works
          </Button>
          <DropdownMenu v-if="hasMenu" :modal="false">
            <DropdownMenuTrigger>
              <Button
                variant="outline"
                :class="JOINED_END"
                size="icon"
                :title="withReason('More refresh options', offline)"
                :aria-describedby="offline ? offlineId : undefined"
                :disabled="!!offline"
              >
                <Icon i-mdi-chevron-down label="More refresh options" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                v-if="refreshable"
                flex="~ col items-start gap-1" px-4 py-3
                @click="refreshAndCache(row)"
              >
                <span text-sm font-medium leading-none>Refresh the list first</span>
                <span line-clamp-2 text-sm text-muted-fg leading-snug>
                  Re-scrape the list, then cache against it. Slower, and the only way the
                  &ldquo;has this work changed?&rdquo; check can be accurate.
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="row.failed"
                flex="~ col items-start gap-1" px-4 py-3
                @click="cacheWorks(row, { retryNow: true })"
              >
                <span text-sm font-medium leading-none>Retry failed works now</span>
                <span line-clamp-2 text-sm text-muted-fg leading-snug>
                  Don't wait out the retry delay on the {{ row.failed.toLocaleString() }}
                  {{ row.failed === 1 ? 'work' : 'works' }} that failed &mdash; for after signing back in to AO3.
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <!--
          A split button only once there is a cache to download: with nothing
          saved yet, "without refreshing" would hand over an empty site.
        -->
        <div flex="~ row items-center">
          <Button
            :class="row.cached ? `${TIGHT} !rounded-r-none` : TIGHT"
            :title="withReason(downloadLabel, offline)"
            :aria-describedby="offline ? offlineId : undefined"
            :disabled="!!offline"
            @click.prevent="downloadSite(row)"
          >
            Download
          </Button>
          <DropdownMenu v-if="row.cached" :modal="false">
            <DropdownMenuTrigger>
              <Button
                :class="`${OFF} !rounded-l-none`"
                size="icon"
                :title="withReason('More download options', offline)"
                :aria-describedby="offline ? offlineId : undefined"
                :disabled="!!offline"
              >
                <Icon i-mdi-chevron-down label="More download options" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                flex="~ col items-start gap-1" px-4 py-3
                @click="downloadCached(row)"
              >
                <span text-sm font-medium leading-none>Download without refreshing</span>
                <span line-clamp-2 text-sm text-muted-fg leading-snug>
                  Package exactly what is saved here now, without asking AO3 for anything.
                  Quick, and as up to date as the {{ row.cached.toLocaleString() }} saved
                  {{ row.cached === 1 ? 'work' : 'works' }} are.
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </template>

      <!--
        Tracking is about the list, not about the export, so it is offered
        whatever the job runner is doing — it writes an option and asks AO3 for
        nothing.
      -->
      <Button
        v-if="trackable"
        variant="outline"
        :class="TIGHT"
        title="Review this list's new and updated works"
        @click.prevent="track(row)"
      >
        Track
      </Button>

      <!--
        Offered even on a list that can't be refreshed — that is the one row for
        which removing it is the only thing left to do.
      -->
      <Button
        variant="outline"
        :class="OFF"
        size="icon"
        :title="removeReason ? withReason(`Remove ${name}`, removeReason) : undefined"
        :aria-describedby="removeReason ? removeId : undefined"
        :disabled="!!removeReason"
        @click.prevent="confirmingDelete = true"
      >
        <Icon i-mdi-trash-can-outline :label="`Remove ${name}`" />
      </Button>
    </div>

    <template #extra>
      <p v-if="!row.descriptor" text="sm muted-fg" pt-1>
        {{ NO_DESCRIPTOR_NOTE }}
      </p>
      <!-- Said where the reader is looking, beside the buttons it turns off. -->
      <p v-if="busyNote" flex="~ row items-start gap-1.5" pt-1 text="sm muted-fg">
        <SeverityGlyph severity="neutral" glyph="i-tabler-circle" mt-0.5 shrink-0 />
        <span :id="offlineId">{{ sentence(busyNote) }}.</span>
      </p>
      <span v-else-if="offline" :id="offlineId" hidden>{{ sentence(offline) }}.</span>
      <span v-if="removeReason" :id="removeId" hidden>{{ sentence(removeReason) }}.</span>
      <!-- Said where the refresh buttons would have been, since it is about them. -->
      <p v-if="review" text="sm muted-fg" pt-1>
        {{ REVIEW_WINDOW_NOTE }}
      </p>
      <!--
        Said here rather than as a switch, because retitling, stopping and
        removing a list all belong together in one place — this row's job is only
        to say that the list is tracked.
      -->
      <p v-if="tracked" text="sm muted-fg" pt-1>
        Tracked — its new and updated works turn up in your review.
        Retitle it or stop tracking it under Search &rarr; Tracked lists, which keeps this stored list; removing the
        list there removes this too.
      </p>
      <SiteExportProgress v-if="mine" />
    </template>
  </OptionRow>

  <Dialog v-model:open="confirmingDelete">
    <DialogContent>
      <DialogTitle>
        Remove this list?
      </DialogTitle>
      <DialogDescription pt-2>
        <strong>{{ name }}</strong> is forgotten here, along with the
        {{ row.count.toLocaleString() }} {{ row.count === 1 ? 'blurb' : 'blurbs' }} saved for it.
        Opening the list on AO3 again brings it straight back &mdash; one scrape, not a re-fetch of
        the works.
        <span v-if="row.cached" block pt-2>
          The {{ row.cached.toLocaleString() }} cached
          {{ row.cached === 1 ? 'work' : 'works' }} ({{ formatBytes(row.bytes) }}) stay. Work text is
          held per work rather than per list, so another list may be reading the same copies; delete
          it from <em>Cached work text</em> below.
        </span>
      </DialogDescription>
      <div flex="~ row justify-end gap-2" pt-4>
        <Button variant="outline" @click.prevent="confirmingDelete = false">
          Cancel
        </Button>
        <Button variant="destructive" @click.prevent="remove">
          Remove list
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
