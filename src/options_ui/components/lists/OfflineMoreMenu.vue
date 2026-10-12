<script setup lang="ts">
import type { SiteExportListRow } from '../../composables/useSiteExport.ts'
import type { MoreItem, MoreItemKind } from '../../model/moreMenu.ts'

import { moreMenu } from '../../model/moreMenu.ts'
import { withReason } from '../../model/phrases.ts'
import { blurbsOnRemove } from '../../model/savedListRows.ts'

/**
 * A stored list's More menu ({@link moreMenu}): what its offline copy offers
 * beyond the buttons beside it, each item named, with a line on what it does.
 * Absent with nothing to offer.
 *
 * An item another list's job turns off says why in its tooltip, and is
 * described by the reason the list says in its own place. So is refreshing
 * first, where the list can't be refreshed for a reason of its own.
 */
const props = withDefaults(defineProps<{
  /** What the list is called, in the trigger's name: "More for …". */
  name: string
  /** The copy the menu acts on. */
  row: SiteExportListRow | null
  retry: number
  cached: number
  /** Why what would start a job is off: another list's job. */
  off: string | null
  /** The id of where the list says that reason. */
  offId: string
  /** Why refreshing first is off, where the list gives its own reason. */
  refreshOff?: string | null
  /** The id of where the list says why refreshing first is off; `offId` without one. */
  refreshOffId?: string
  /** Offer the list refreshed before it is cached: only for a list read from one listing. */
  refresh?: boolean
  /** Offer to remove the copy. */
  remove?: boolean
}>(), { refresh: false, remove: false })

const { refreshAndCache, cacheWorks, downloadCached, deleteList } = useSiteExport()

const menu = computed(() => moreMenu(props))

/** Where an item that is off has its reason said. */
function reasonId(item: MoreItem): string | undefined {
  if (!item.off)
    return undefined
  return item.kind === 'refresh-first' ? props.refreshOffId ?? props.offId : props.offId
}

type JobItem = Exclude<MoreItemKind, 'remove'>

/** Each item that starts a job: its name, as its tooltip gives it too, and the job. */
const JOBS: Record<JobItem, { name: string, start: (row: SiteExportListRow) => unknown }> = {
  'refresh-first': { name: 'Refresh the list first', start: refreshAndCache },
  'retry': { name: 'Retry failed works now', start: row => cacheWorks(row, { retryNow: true }) },
  'download-cached': { name: 'Download without refreshing', start: downloadCached },
}

/** Whether removing the copy takes its blurbs now, which the menu says. */
const prune = useOption('pruneOrphanedBlurbs')

/** Removing the copy asks a second time in its own place, with the menu left open between the two. */
const confirm = useConfirmInPlace()
const removeId = computed(() => `remove-copy:${props.row?.key ?? props.name}`)

function remove(event: Event): void {
  if (!props.row)
    return
  if (!confirm.press(removeId.value)) {
    event.preventDefault()
    return
  }
  void deleteList(props.row)
}

/** Run one of the copy's jobs. */
function run(item: JobItem): void {
  if (props.row)
    void JOBS[item].start(props.row)
}

/**
 * The items: a name and a line on what it does. The menu is drawn outside the
 * list, where the list's own styles don't reach, so these are utility classes.
 * Armed, Remove fills with the armed red.
 */
const ITEM = 'flex flex-col items-start gap-0.5 px-[11px] py-2'
const NAME = 'text-[12.5px] font-500 leading-[17px]'
const NOTE = 'text-[11.5px] leading-4 text-muted-fg'
const ARMED = '!bg-armed !text-armed-fg [&>*]:!text-armed-fg'
</script>

<template>
  <DropdownMenu v-if="menu" :modal="false">
    <DropdownMenuTrigger>
      <button type="button" class="icon-btn" :aria-label="`More for ${name}`" :title="menu.title">
        <span class="i-tabler-dots" text="[16px]" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="max-w-[calc(100vw-32px)] w-[310px] p-[5px]">
      <template v-for="item in menu.items" :key="item.kind">
        <DropdownMenuItem
          v-if="item.kind === 'remove'"
          :class="[ITEM, confirm.armed(removeId) ? ARMED : '']"
          @select="remove"
        >
          <span :class="NAME">{{ confirm.armed(removeId) ? 'Remove offline copy?' : 'Remove offline copy' }}</span>
          <span :class="NOTE">
            Opening the list on AO3 keeps a copy again. Its cached work text stays. {{ blurbsOnRemove(prune) }}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          v-else
          :disabled="!!item.off"
          :title="withReason(JOBS[item.kind].name, item.off)"
          :aria-describedby="reasonId(item)"
          :class="ITEM"
          @select="run(item.kind)"
        >
          <span :class="NAME">{{ JOBS[item.kind].name }}</span>
          <span v-if="item.kind === 'refresh-first'" :class="NOTE">
            Re-scrape the list, then cache against it. Slower, and the only way the
            &ldquo;has this work changed?&rdquo; check can be accurate.
          </span>
          <span v-else-if="item.kind === 'retry'" :class="NOTE">
            Don't wait out the retry delay on the {{ retry.toLocaleString() }}
            {{ retry === 1 ? 'work' : 'works' }} that failed &mdash; for after signing back in to AO3.
          </span>
          <span v-else :class="NOTE">
            Package exactly what is saved here now, without asking AO3 for anything. Quick, and as up to date as
            the {{ cached.toLocaleString() }} saved {{ cached === 1 ? 'work' : 'works' }} are.
          </span>
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
