<script setup lang="ts">
import type { SavedListHold, SavedListSort } from '../../model/listView.ts'

import { anchorSlug } from '../../model/anchors.ts'
import { busyNotice } from '../../model/jobView.ts'
import { focusSuccessor, SAVED_LIST_SORTS, savedListsHead, shownSavedLists } from '../../model/listView.ts'

/**
 * Saved lists: one row per saved list, tracked or not, and per stored list
 * no saved list is at yet, with what acts on all of them over the rows — a
 * filter, a sort, and, while the one job runs, whose it is, since it turns
 * every other row's offline actions off.
 *
 * The filter and the sort only change what is shown, and last as long as the
 * page. A settings search fills the filter, so the rows it found are the ones
 * shown. While a title has focus the rows hold still, whatever the sort or
 * the filter would do, so the field never moves out from under the typing.
 */
const { savedRows, rowFor, view, loading } = useSiteExport()
const { enabled } = useOption('trackedLists')
const { query: settingsQuery } = useOptionSearch()

const filter = ref('')
watch(settingsQuery, (query) => {
  filter.value = query
})
const sort = ref<SavedListSort>('name')
const hold = ref<SavedListHold | null>(null)

const shown = computed(() => shownSavedLists(savedRows.value, { query: filter.value, sort: sort.value, hold: hold.value }))
const head = computed(() => savedListsHead(savedRows.value, shown.value, filter.value))
const busy = computed(() => busyNotice(view.value))
const now = useNow({ interval: 60_000 })

/**
 * Each row's anchor: its name under Saved lists, as a settings row's is; a
 * name two rows share gets the row's id as well, so each has one of its own.
 */
const anchors = computed(() => {
  const slugs = new Map(savedRows.value.map(row => [row.id, anchorSlug(`Saved lists ${row.title || row.placeholder}`)]))
  const counts = new Map<string, number>()
  for (const slug of slugs.values())
    counts.set(slug, (counts.get(slug) ?? 0) + 1)
  return Object.fromEntries([...slugs].map(([id, slug]) => [id, (counts.get(slug) ?? 0) > 1 ? `${slug}-${anchorSlug(id)}` : slug]))
})

/** A title took focus: the rows hold the order they are in, and that row stays whatever the filter says. */
function holdRows(id: string): void {
  hold.value = { order: hold.value?.order ?? shown.value.map(row => row.id), focused: id }
}

/** Focus left a title: the rows may move again, unless it went straight to another title. */
function releaseRows(event: FocusEvent): void {
  const next = event.relatedTarget
  if (!(next instanceof HTMLElement && next.dataset.savedListTitle !== undefined))
    hold.value = null
}

/**
 * A row that goes with focus in it, removed or turned into the saved list it
 * now is, hands focus to the row now in its place, else to the filter, so a
 * reader on the keyboard stays in the list.
 */
const frame = useTemplateRef<HTMLElement>('frame')
const lostFocus = useLostFocus(frame)
watch(() => shown.value.map(row => row.id), (ids, before) => {
  const gone = lostFocus.lost()?.closest<HTMLElement>('[data-saved-list]')?.dataset.savedList
  if (gone === undefined || ids.includes(gone))
    return
  const next = focusSuccessor(before, ids, gone)
  const row = next === null ? null : frame.value?.querySelector(`[data-saved-list="${CSS.escape(next)}"]`)
  const target = row?.querySelector<HTMLElement>('input, button, a[href]') ?? frame.value?.querySelector<HTMLElement>('input')
  target?.focus()
}, { flush: 'post' })

/** Escape empties the filter, and goes no further while it holds anything. */
function escape(event: KeyboardEvent): void {
  if (!filter.value)
    return
  filter.value = ''
  event.stopPropagation()
}

const HOW = 'Lists arrive from AO3 itself: Track this search in the floating toolbar, or the search button on a listing.'
const howId = useId()
</script>

<template>
  <div ref="frame" class="saved-lists">
    <ListFrame
      list-id="saved-lists"
      title="Saved lists"
      :count="head.count"
      :short-count="head.shortCount"
      cap="section"
      :empty="!shown.length"
    >
      <template #filter>
        <ListFilter
          v-model="filter"
          label="Filter saved lists"
          :placeholder="head.placeholder"
          clear-label="Clear the filter"
          @keydown.esc="escape"
        />
        <span v-if="busy" class="saved-lists__busy saved-lists__busy--head">
          <span class="saved-lists__spinner i-tabler-loader-2 motion-safe:animate-spin" aria-hidden="true" />
          {{ busy }}
        </span>
      </template>
      <template #controls>
        <ListSort v-model="sort" :choices="SAVED_LIST_SORTS" />
        <Tooltip :content="HOW">
          <button type="button" class="icon-btn" aria-label="How lists get here" :aria-describedby="howId">
            <span class="i-tabler-help-circle" text="[15px]" aria-hidden="true" />
          </button>
        </Tooltip>
        <span :id="howId" hidden>{{ HOW }}</span>
      </template>

      <template #bands>
        <p v-if="busy" class="saved-lists__band saved-lists__busy--band">
          <span class="saved-lists__spinner i-tabler-loader-2 motion-safe:animate-spin" aria-hidden="true" />
          {{ busy }}
        </p>
        <p v-if="!enabled" class="saved-lists__band">
          <span class="saved-lists__band-glyph i-tabler-player-pause" aria-hidden="true" />
          <span>Review is off — <b>Tracked lists</b> is switched off above. Titles and dates are kept.</span>
        </p>
        <div v-if="shown.length" class="saved-lists__heads" aria-hidden="true">
          <span>List</span>
          <span><span class="i-tabler-circle-check" />Status</span>
          <span><span class="i-tabler-database" />Caching</span>
          <span><span class="i-tabler-cloud-download" />Offline copy</span>
        </div>
      </template>

      <template #empty>
        <template v-if="savedRows.length">
          <b>No lists match “{{ filter.trim() }}”</b>
        </template>
        <template v-else-if="loading">
          Looking for saved lists…
        </template>
        <template v-else>
          <b>No saved lists yet</b>Use <em>Track this search</em> in the floating toolbar on a search, a tag’s works or a
          series — or open one on AO3 and press its search button to keep a copy. It will appear here.
        </template>
      </template>

      <SavedListItem
        v-for="row in shown"
        :key="row.id"
        :row="row"
        :copy="row.caching.kind === 'copy' ? rowFor(row.caching.key) : null"
        :anchor="anchors[row.id] ?? anchorSlug(`Saved lists ${row.id}`)"
        :now="now.getTime()"
        @title-focus="holdRows(row.id)"
        @title-blur="releaseRows"
      />
    </ListFrame>
  </div>
</template>

<style scoped>
.saved-lists {
  margin-top: 10px;
}
.saved-lists__busy {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background-color: rgb(var(--color-brand-fg) / 0.1);
  color: rgb(var(--color-default-fg));
  font-size: 11.5px;
  white-space: nowrap;
}
.saved-lists__spinner {
  flex: none;
  color: rgb(var(--color-brand-fg));
}
.saved-lists__band {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  margin: 0;
  padding: 4px 10px;
  border-bottom: 1px solid rgb(var(--color-hair));
  background-color: rgb(var(--color-muted));
  color: rgb(var(--color-default-fg));
  font-size: 11.5px;
  line-height: 15px;
}
.saved-lists__band b {
  font-weight: 600;
}
.saved-lists__band-glyph {
  flex: none;
  color: rgb(var(--color-muted-fg));
}
.saved-lists__busy--band {
  display: none;
}

/*
  The column heads line up with the rows' columns. The rows sit in a body that
  keeps room for its scrollbar, so the heads keep the same room.
*/
.saved-lists__heads {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 168px 236px 128px;
  gap: 14px;
  padding: 5px 6px 5px 10px;
  overflow: hidden;
  scrollbar-gutter: stable;
  border-bottom: 1px solid rgb(var(--color-hair));
  color: rgb(var(--color-muted-fg));
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.saved-lists__heads > span {
  display: flex;
  align-items: center;
  gap: 5px;
}

@container (max-width: 839px) {
  .saved-lists__heads {
    display: none;
  }
}
@container (max-width: 560px) {
  .saved-lists__busy--head {
    display: none;
  }
  .saved-lists__busy--band {
    display: flex;
  }
}
</style>
