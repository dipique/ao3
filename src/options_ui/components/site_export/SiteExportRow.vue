<script setup lang="ts">
import type { SiteExportListRow } from '../../composables/useSiteExport.ts'

// Named rather than left to the auto-import: both are read from the template,
// and auto-imports only reach `<script setup>`.
import { formatBytes, NO_DESCRIPTOR_NOTE } from '../../composables/useSiteExport.ts'

/**
 * One stored works list, as a row in Advanced → Site export.
 *
 * The buttons are state-dependent rather than always-available, because the job
 * runner is a singleton: while any list is being fetched, every other row's
 * actions are off — two runs would only double the request rate AO3 is asked to
 * carry.
 *
 * They are also **deliberately terse**. A list's name is the only thing here the
 * reader can't reconstruct, and every pixel the buttons take is a pixel it
 * doesn't get — so what would read as "Refresh list" and "Cache works" is a
 * refresh cap and two words, with the long form kept as each button's tooltip
 * and accessible name.
 */
const props = defineProps<{ row: SiteExportListRow }>()

const {
  status,
  resumable,
  refreshList,
  cacheWorks,
  refreshAndCache,
  downloadSite,
  downloadCached,
  deleteList,
  stop,
  resume,
  discard,
} = useSiteExport()

/** The job belongs to this list. Another list's job only greys this row out. */
const mine = computed(() => status.value.job?.cacheKey === props.row.key)
const running = computed(() => status.value.running && mine.value)
/** Something else is running, so nothing here may start. */
const busy = computed(() => status.value.running && !mine.value)
/** A job of ours that stopped with work left — offer to carry on, not to restart. */
const paused = computed(() => mine.value && resumable.value)

const cacheLabel = computed(() => (props.row.cached ? 'Update the cached works' : 'Cache this list\'s works'))

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
  <OptionRow :title="row.label" :subtitle="row.summary" stacked control-width="24rem">
    <!--
      Where the list actually is. A row can be refreshed from here only after the
      view has scraped it once, so "go and open it" is a real instruction — and
      one worth making a click rather than a search.
    -->
    <template #title-suffix>
      <ArchiveLink
        v-if="row.listUrl"
        :href="row.listUrl"
        :aria-label="`Open ${row.label} on AO3`"
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
        <Button :class="OFF" :disabled="busy" @click.prevent="resume()">
          Continue
        </Button>
        <Button variant="ghost" :class="OFF" :disabled="busy" @click.prevent="discard()">
          Discard
        </Button>
      </template>

      <template v-else>
        <!--
          Refresh: the list, the works, or the menu. The cap is the verb and is
          not a button — there is nothing sensible for "refresh, unspecified" to
          do — so each button below carries the whole phrase as its own label.
        -->
        <div flex="~ row items-center">
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
            :title="`Refresh the list of works in ${row.label}`"
            :disabled="!row.descriptor || busy"
            @click.prevent="refreshList(row)"
          >
            List
          </Button>
          <Button
            variant="outline"
            :class="JOINED"
            :title="cacheLabel"
            :disabled="!row.descriptor || busy"
            @click.prevent="cacheWorks(row)"
          >
            Works
          </Button>
          <DropdownMenu :modal="false">
            <DropdownMenuTrigger>
              <Button
                variant="outline"
                :class="JOINED_END"
                size="icon"
                :disabled="!row.descriptor || busy"
              >
                <Icon i-mdi-chevron-down label="More refresh options" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
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
            title="Refresh, cache, then save this list as one HTML file"
            :disabled="!row.descriptor || busy"
            @click.prevent="downloadSite(row)"
          >
            Download
          </Button>
          <DropdownMenu v-if="row.cached" :modal="false">
            <DropdownMenuTrigger>
              <Button
                :class="`${OFF} !rounded-l-none`"
                size="icon"
                :disabled="!row.descriptor || busy"
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
        Offered even on a list that can't be refreshed — that is the one row for
        which removing it is the only thing left to do.
      -->
      <Button
        variant="outline"
        :class="OFF"
        size="icon"
        :disabled="running"
        @click.prevent="confirmingDelete = true"
      >
        <Icon i-mdi-trash-can-outline :label="`Remove ${row.label}`" />
      </Button>
    </div>

    <template #extra>
      <p v-if="!row.descriptor" text="sm muted-fg" pt-1>
        {{ NO_DESCRIPTOR_NOTE }}
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
        <strong>{{ row.label }}</strong> is forgotten here, along with the
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
