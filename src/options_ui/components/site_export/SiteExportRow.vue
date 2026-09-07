<script setup lang="ts">
import type { SiteExportListRow } from '../../composables/useSiteExport.ts'

/**
 * One stored works list, as a row in Advanced → Site export (the plan's §1,
 * {@link file://../../../../../plans/site-export.md}).
 *
 * The buttons are state-dependent rather than always-available, because the job
 * runner is a singleton: while any list is being fetched, every other row's
 * actions are off — two runs would only double the request rate AO3 is asked to
 * carry.
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

const cacheLabel = computed(() => (props.row.cached ? 'Update cache' : 'Cache works'))
</script>

<template>
  <OptionRow :title="row.label" :subtitle="row.summary">
    <div flex="~ row items-center gap-2">
      <Button
        variant="outline"
        class="disabled:cursor-default disabled:op-50"
        :disabled="!row.descriptor || running || busy"
        @click.prevent="refreshList(row)"
      >
        Refresh list
      </Button>

      <Button v-if="running" variant="outline" @click.prevent="stop()">
        Stop
      </Button>

      <template v-else-if="paused">
        <Button class="disabled:cursor-default disabled:op-50" :disabled="busy" @click.prevent="resume()">
          Continue
        </Button>
        <Button variant="ghost" class="disabled:cursor-default disabled:op-50" :disabled="busy" @click.prevent="discard()">
          Discard
        </Button>
      </template>

      <template v-else>
        <Button
          variant="outline"
          class="disabled:cursor-default disabled:op-50"
          :disabled="!row.descriptor || busy"
          @click.prevent="cacheWorks(row)"
        >
          {{ cacheLabel }}
        </Button>
        <DropdownMenu :modal="false">
          <DropdownMenuTrigger>
            <Button
              variant="outline"
              class="disabled:cursor-default disabled:op-50"
              size="icon"
              :disabled="!row.descriptor || busy"
            >
              <Icon i-mdi-chevron-down label="More caching options" />
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

        <Button
          class="disabled:cursor-default disabled:op-50"
          :disabled="!row.descriptor || busy"
          @click.prevent="downloadSite(row)"
        >
          Download site
        </Button>
        <!--
          A split button only once there is a cache to download: with nothing
          saved yet, "without refreshing" would hand over an empty site.
        -->
        <DropdownMenu v-if="row.cached" :modal="false">
          <DropdownMenuTrigger>
            <Button
              class="disabled:cursor-default disabled:op-50"
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
      </template>
    </div>

    <template #extra>
      <SiteExportProgress v-if="mine" />
    </template>
  </OptionRow>
</template>
