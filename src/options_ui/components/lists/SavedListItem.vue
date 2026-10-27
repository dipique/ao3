<script setup lang="ts">
import type { SavedList } from '#common'

import { getArchiveLink, toast } from '#common'

import type { SiteExportListRow } from '../../composables/useSiteExport.ts'
import type { SavedListRow } from '../../model/savedListRows.ts'

import { sentence, withReason } from '../../model/phrases.ts'
import { cachingCell, COPIED_MS, describeList, NEEDS_VISIT_NOTE, NOT_ARCHIVE_NOTE, offlineDetails, rowAction, rowJob, sameSearchNote, SHARED_TITLE_NOTE, statusCell, titleRefusal, TRACK_OFF, trackingDetails, VIEW_EDIT_NOTE } from '../../model/savedListRows.ts'

/**
 * One saved list, as a row of Saved lists: what it is, whether it is tracked,
 * what of it is cached, and Download, with the rest behind the details
 * chevron — the offline copy's actions on one side, tracking and removing the
 * list on the other. A job on its copy grows its line under the row.
 *
 * A stored list no saved list is at is a row too, by the title its record will
 * take, or by its raw key: it has no record, so no title to set and no list to
 * remove, only its copy.
 *
 * The title is typed in place and saved as the field is left or Enter is
 * pressed, so a half-typed title never renames the list on another browser.
 * One another list has is refused, kept in the field, and the row says which
 * list has it. While the field has focus the list holds the rows still: the
 * row tells it as the field takes and leaves focus.
 *
 * Every control that is off says why, in its tooltip and its description.
 */
const props = defineProps<{
  row: SavedListRow
  /** Its offline copy, the stored list at its address; null with none. */
  copy: SiteExportListRow | null
  /** Its anchor: the settings search finds it by its name, and a `#hash` lands on it. */
  anchor: string
  /** The time the row's ages are counted to. */
  now: number
}>()

const emit = defineEmits<{
  /** Its title took focus. */
  titleFocus: []
  /** Its title lost focus, to `event.relatedTarget`. */
  titleBlur: [event: FocusEvent]
}>()

const {
  view,
  refreshList,
  cacheWorks,
  refreshAndCache,
  downloadSite,
  downloadCached,
  deleteList,
  removeListCopies,
  removeList,
  stop,
  cancel,
  resume,
  discard,
  trackCopy,
} = useSiteExport()
const { retitle, setTracked } = useSavedLists()
const prune = useOption('pruneOrphanedBlurbs')
const confirm = useConfirmInPlace()

/** What the row is called: its title, or, with none, what stands in for one. */
const name = computed(() => props.row.title || props.row.placeholder)

useSearchableRow(() => ({ title: name.value, subtitle: '' }), () => props.anchor)

const status = computed(() => statusCell(props.row))
const caching = computed(() => cachingCell(props.row, view.value, props.now))
/** The caching cell's two lines, whole, for where they are cut short. */
const cachingTip = computed(() => `${caching.value.line}\n${caching.value.detail}`)
const action = computed(() => rowAction(props.row, view.value))
const copyKey = computed(() => (props.row.caching.kind === 'copy' ? props.row.caching.key : null))
/** The job's line is this row's: running, stopped or finished on any of its copies. */
const job = computed(() => rowJob(props.row, view.value))

const open = ref(false)
const offline = computed(() => offlineDetails(props.row, view.value, props.now, prune.value))
const tracking = computed(() => trackingDetails(props.row, view.value, prune.value))

const viewEdit = computed(() => (props.row.viewEdit ? getArchiveLink(props.row.viewEdit) : null))
/** The list's open URL, whole: its page on AO3 naming it by its id, which opens its search view. */
const openUrl = computed(() => (props.row.open ? getArchiveLink(props.row.open) : null))
const sameSearch = computed(() => sameSearchNote(props.row))

const ids = {
  trackOff: useId(),
  offlineOff: useId(),
  refreshOff: useId(),
  removeCopyOff: useId(),
  removeListOff: useId(),
  how: useId(),
}

/**
 * A control pressed in the row can go with the press: Download turns into
 * Pause, Pause leaves the row its job's Continue, a removed copy takes its
 * button. Focus then goes to the row's own control in the Offline copy column,
 * else its details chevron, so the keyboard stays in the row.
 */
const root = useTemplateRef<HTMLElement>('root')
const lostFocus = useLostFocus(root)
onUpdated(() => {
  if (lostFocus.lost())
    root.value?.querySelector<HTMLElement>('[data-saved-list-part="actions"] button:not(:disabled)')?.focus()
})

// ---------------------------------------------------------------------------
// The title
// ---------------------------------------------------------------------------

const field = useTemplateRef<HTMLInputElement>('field')
/** What is typed in the field while it differs from the stored title. */
const draft = ref<string | null>(null)
/** The list that has the title last committed, which wasn't saved. */
const refused = ref<SavedList | null>(null)

function typed(event: Event): void {
  draft.value = (event.target as HTMLInputElement).value
  refused.value = null
}

/** Save what is typed, unless another list has it: then it stays in the field, refused. */
function commit(): void {
  if (draft.value === null)
    return
  const takenBy = retitle(props.row.id, draft.value)
  if (takenBy) {
    refused.value = takenBy
    return
  }
  draft.value = null
}

function left(event: FocusEvent): void {
  commit()
  emit('titleBlur', event)
}

/** Put the saved title back in the field, and the refusal goes with it. */
function undoTitle(): void {
  draft.value = null
  refused.value = null
  field.value?.focus()
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** Track the list or stop: a list by its record, a stored list no list is at yet by its copy. */
function track(on: boolean): void {
  if (!props.row.titleEditable) {
    if (on && copyKey.value)
      trackCopy(copyKey.value)
    return
  }
  const twin = setTracked(props.row.id, on)
  if (twin)
    toast(`This search is already tracked as ${describeList(twin)}.`, { type: 'error' })
}

// ---------------------------------------------------------------------------
// Copy URL
// ---------------------------------------------------------------------------

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Put the list's open URL on the clipboard, and say so for a moment. A browser
 * that refuses the clipboard to a page without a fresh click says nothing.
 */
async function copyUrl(): Promise<void> {
  if (!openUrl.value)
    return
  try {
    await navigator.clipboard.writeText(openUrl.value)
  }
  catch {
    return
  }
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copied.value = false
  }, COPIED_MS)
}

onBeforeUnmount(() => clearTimeout(copiedTimer))

// ---------------------------------------------------------------------------
// The offline copy
// ---------------------------------------------------------------------------

const refreshLabel = computed(() => `Refresh the list of works in ${name.value}`)
const cacheLabel = computed(() => (offline.value.cached ? 'Update the cached works' : 'Cache this list\'s works'))
const DOWNLOAD_LABEL = 'Refresh, cache, then save this list as one HTML file'

/** Run one of the copy's jobs. */
function run(start: (row: SiteExportListRow) => unknown): void {
  if (props.copy)
    void start(props.copy)
}

const removeCopyId = computed(() => `remove-copy:${copyKey.value}`)
const removeListId = computed(() => `remove-list:${props.row.id}`)

/** A saved list's copy goes with any older sort order of its search behind it; a stored list of its own is only itself. */
function removeCopy(): void {
  if (!props.copy || !confirm.press(removeCopyId.value))
    return
  if (props.row.titleEditable)
    void removeListCopies(props.row.id)
  else
    void deleteList(props.copy)
}

function removeTheList(): void {
  if (confirm.press(removeListId.value))
    void removeList(props.row.id)
}
</script>

<template>
  <div
    :id="anchor"
    ref="root"
    role="listitem"
    :data-list-row="row.id"
    :data-saved-list="row.id"
    class="saved-list"
    :class="{ 'saved-list--job': job?.here }"
    style="scroll-margin-top: var(--shell-top);"
  >
    <div class="saved-list__row">
      <div class="saved-list__id" data-saved-list-part="list">
        <input
          v-if="row.titleEditable"
          ref="field"
          type="text"
          class="saved-list__title input-ring"
          data-saved-list-title
          :value="draft ?? row.title"
          :placeholder="row.placeholder"
          :aria-label="`Title for ${name}`"
          :aria-invalid="refused ? 'true' : undefined"
          @input="typed"
          @focus="emit('titleFocus')"
          @blur="left"
          @keydown.enter="commit"
        >
        <div v-else class="saved-list__name-line">
          <span class="saved-list__name" :class="{ 'saved-list__name--raw': row.rawKey }" :title="row.title">{{ row.title }}</span>
          <ArchiveLink v-if="row.rawKey && copy?.listUrl" :href="copy.listUrl" :aria-label="`Open ${name} on AO3`" data-action="open" class="saved-list__open touch-target">
            Open on AO3
          </ArchiveLink>
        </div>

        <p v-if="refused" class="saved-list__note" role="alert">
          <SeverityGlyph severity="destructive" class="saved-list__glyph" />
          <span>
            {{ titleRefusal(refused) }}
            <button type="button" class="saved-list__link-btn touch-target link" :aria-label="`Undo: put back the title ${row.title}`" data-action="undo" @click="undoTitle">(undo)</button>
          </span>
        </p>
        <p v-else-if="row.pending === 'not-archive'" class="saved-list__note">
          <SeverityGlyph severity="destructive" class="saved-list__glyph" />
          <span>{{ NOT_ARCHIVE_NOTE }}</span>
        </p>
        <p v-else-if="row.pending === 'needs-visit'" class="saved-list__note">
          <SeverityGlyph severity="warning" class="saved-list__glyph" />
          <span>{{ NEEDS_VISIT_NOTE }}</span>
        </p>
        <div v-else class="saved-list__what">
          <span v-if="row.type" class="saved-list__badge" :title="row.typeTip">{{ row.type }}</span>
          <span v-if="row.kind">{{ row.kind }}</span>
          <template v-if="row.filters.text">
            <span aria-hidden="true">·</span>
            <!--
              One line: what the summary had to leave out, or the row's width
              cuts off, is in the tooltip, and a screen reader gets the whole
              of it in place of the shortened line.
            -->
            <span class="saved-list__trunc" :title="row.filters.full" data-saved-list-filters>
              <template v-if="row.filters.more">
                <span aria-hidden="true">{{ row.filters.text }}</span>
                <span class="sr-only">{{ row.filters.full }}</span>
              </template>
              <template v-else>{{ row.filters.text }}</template>
            </span>
          </template>
          <template v-if="row.sharedTitle">
            <span aria-hidden="true">·</span>
            <span class="saved-list__shared" :title="SHARED_TITLE_NOTE" data-saved-list-shared-title>
              <SeverityGlyph severity="warning" class="saved-list__glyph" />Same title as another list
            </span>
          </template>
          <template v-if="sameSearch">
            <span aria-hidden="true">·</span>
            <span class="saved-list__trunc" data-saved-list-same-search>{{ sameSearch }}</span>
          </template>
          <template v-if="viewEdit">
            <span aria-hidden="true">·</span>
            <ArchiveLink
              :href="viewEdit"
              :aria-label="`View or edit ${name} on AO3`"
              data-action="view-edit"
              title="Opens it ready to edit: change the search there, and the floating toolbar offers to update this list"
              class="touch-target"
            >
              View/Edit
            </ArchiveLink>
          </template>
          <button
            v-if="openUrl"
            type="button"
            class="saved-list__copy touch-target input-ring"
            :data-copied="copied"
            data-action="copy-url"
            :aria-label="`${copied ? 'Copied' : 'Copy'} the AO3 address of ${name}`"
            title="Copy this list's address on AO3"
            @click="copyUrl"
          >
            <span :class="copied ? 'i-tabler-check saved-list__copied' : 'i-tabler-copy'" aria-hidden="true" />
            {{ copied ? 'Copied' : 'Copy URL' }}
          </button>
        </div>
      </div>

      <div
        class="saved-list__status"
        data-saved-list-part="status"
        :data-saved-list-status="row.status"
        :data-saved-list-pending="row.pending ?? undefined"
        :class="{ 'saved-list__status--off': row.trackOff === TRACK_OFF.review }"
      >
        <IconToggle
          v-if="status.toggle.kind === 'switch'"
          as-switch
          icon="i-tabler-circle-check"
          :label="`Track ${name}`"
          :tip="status.toggle.title"
          :model-value="row.status === 'tracked'"
          :disabled="!!row.trackOff || undefined"
          :aria-describedby="row.trackOff ? ids.trackOff : undefined"
          @update:model-value="track"
        />
        <span v-else class="saved-list__no-switch" role="img" :aria-label="status.toggle.title" :title="status.toggle.title">
          <span class="i-tabler-circle-dashed" aria-hidden="true" />
        </span>
        <span class="saved-list__lines" :title="status.tip" :class="{ 'saved-list__lines--muted': row.status !== 'tracked' }">
          <span class="saved-list__l1">{{ status.word }}</span>
          <span v-if="status.detail" class="saved-list__l2">{{ status.detail }}</span>
        </span>
        <span v-if="row.trackOff" :id="ids.trackOff" hidden>{{ sentence(row.trackOff) }}.</span>
      </div>

      <div class="saved-list__caching" data-saved-list-part="caching" :data-saved-list-caching="row.caching.kind">
        <BucketBar v-if="caching.bar" :bar="caching.bar" class="saved-list__bar" />
        <span v-else class="saved-list__bar saved-list__bar--none" aria-hidden="true" />
        <span class="saved-list__lines" :class="{ 'saved-list__lines--muted': caching.muted }" :title="cachingTip">
          <span class="saved-list__l1" data-saved-list-caching-line>{{ caching.line }}</span>
          <ArchiveLink
            v-if="caching.link"
            :href="getArchiveLink(caching.link)"
            :aria-label="`Open ${name} on AO3 to keep a copy`"
            data-action="open"
            class="saved-list__l2 saved-list__hint touch-target"
          >{{ caching.detail }}</ArchiveLink>
          <span v-else class="saved-list__l2">{{ caching.detail }}</span>
        </span>
      </div>

      <div class="saved-list__actions" data-saved-list-part="actions">
        <button
          v-if="action.kind === 'download'"
          type="button"
          class="saved-list__act outline-btn"
          :aria-label="`Download ${name}`"
          :title="withReason(DOWNLOAD_LABEL, action.off)"
          :disabled="!!action.off"
          :aria-describedby="action.off ? ids.refreshOff : undefined"
          data-action="download"
          @click="run(downloadSite)"
        >
          <span class="i-tabler-download" aria-hidden="true" />
          <span class="saved-list__act-label">Download</span>
        </button>
        <template v-else-if="action.kind === 'stop'">
          <!-- Two to a column that holds one labelled button: their names are their tooltips. -->
          <button
            type="button"
            class="saved-list__act saved-list__act--icon outline-btn"
            :aria-label="`Pause ${action.verb} ${name}`"
            title="Pause"
            data-action="pause"
            @click="stop()"
          >
            <span class="i-tabler-player-pause" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="saved-list__act saved-list__act--icon outline-btn"
            :aria-label="`Cancel ${action.verb} ${name}`"
            title="Cancel"
            data-action="cancel"
            @click="cancel()"
          >
            <span class="i-tabler-x" aria-hidden="true" />
          </button>
        </template>
        <button
          type="button"
          class="saved-list__disclose icon-btn"
          data-action="details"
          :aria-expanded="open"
          :aria-label="`Details for ${name}`"
          @click="open = !open"
        >
          <span class="i-tabler-chevron-down" text="[15px]" aria-hidden="true" />
        </button>
        <span v-if="offline.off" :id="ids.offlineOff" hidden>{{ sentence(offline.off) }}.</span>
        <span v-if="offline.refreshOff" :id="ids.refreshOff" hidden>{{ sentence(offline.refreshOff) }}.</span>
      </div>
    </div>

    <div v-if="job?.here" class="saved-list__job">
      <SiteExportProgress>
        <template v-if="job.actions === 'resume'" #foot>
          <button type="button" class="primary-btn small-btn" data-action="resume" @click="resume()">
            <span class="i-tabler-player-play" aria-hidden="true" />
            Continue
          </button>
          <button type="button" class="saved-list__discard ghost-btn small-btn" data-action="discard" @click="discard()">
            Discard
          </button>
        </template>
      </SiteExportProgress>
    </div>

    <div v-if="open" class="saved-list__details" data-saved-list-part="details">
      <section :aria-label="`Offline copy of ${name}`" class="saved-list__half">
        <h3 class="saved-list__dt">
          <span class="i-tabler-cloud-download" aria-hidden="true" />Offline copy
        </h3>
        <template v-if="offline.summary">
          <p class="saved-list__dd">
            {{ offline.summary }}
          </p>
          <p v-if="offline.refreshNote" class="saved-list__note">
            <SeverityGlyph :severity="offline.refreshNote.severity" class="saved-list__glyph" />
            <span class="saved-list__muted">{{ offline.refreshNote.text }}</span>
          </p>
          <p v-if="offline.note" class="saved-list__note">
            <SeverityGlyph :severity="offline.note.severity" class="saved-list__glyph" />
            <span :class="{ 'saved-list__muted': offline.note.severity === 'neutral' }">{{ offline.note.text }}</span>
          </p>
          <div class="saved-list__buttons">
            <button
              type="button"
              class="saved-list__btn outline-btn"
              :title="withReason(refreshLabel, offline.refreshOff)"
              :disabled="!!offline.refreshOff"
              :aria-describedby="offline.refreshOff ? ids.refreshOff : undefined"
              data-action="refresh"
              @click="run(refreshList)"
            >
              <span class="i-tabler-refresh" aria-hidden="true" />
              Refresh list
            </button>
            <button
              type="button"
              class="saved-list__btn outline-btn"
              :title="withReason(cacheLabel, offline.off)"
              :disabled="!!offline.off"
              :aria-describedby="offline.off ? ids.offlineOff : undefined"
              data-action="cache"
              @click="run(cacheWorks)"
            >
              <span class="i-tabler-cloud-download" aria-hidden="true" />
              Cache works
            </button>
            <button
              type="button"
              class="saved-list__btn outline-btn"
              :title="withReason(DOWNLOAD_LABEL, offline.refreshOff)"
              :disabled="!!offline.refreshOff"
              :aria-describedby="offline.refreshOff ? ids.refreshOff : undefined"
              data-action="download"
              @click="run(downloadSite)"
            >
              <span class="i-tabler-download" aria-hidden="true" />
              Download
            </button>
          </div>
          <div class="saved-list__links">
            <button
              type="button"
              class="saved-list__link-btn touch-target link"
              :title="offline.refreshOff ? sentence(offline.refreshOff) : 'Re-scrape the list, then cache against it. Slower, and the only way the “has this work changed?” check can be accurate.'"
              :disabled="!!offline.refreshOff"
              :aria-describedby="offline.refreshOff ? ids.refreshOff : undefined"
              data-action="refresh-first"
              @click="run(refreshAndCache)"
            >
              Refresh the list first, then cache
            </button>
            <button
              v-if="offline.retry"
              type="button"
              class="saved-list__link-btn touch-target link"
              :title="offline.off ? sentence(offline.off) : 'Don\'t wait out the retry delay on the works that failed — for after signing back in to AO3.'"
              :disabled="!!offline.off"
              :aria-describedby="offline.off ? ids.offlineOff : undefined"
              data-action="retry"
              @click="copy && cacheWorks(copy, { retryNow: true })"
            >
              Retry the {{ offline.retry.toLocaleString() }} failed {{ offline.retry === 1 ? 'work' : 'works' }} now
            </button>
            <button
              v-if="offline.cached"
              type="button"
              class="saved-list__link-btn touch-target link"
              :title="offline.off ? sentence(offline.off) : 'Package exactly what is saved here now, without asking AO3 for anything.'"
              :disabled="!!offline.off"
              :aria-describedby="offline.off ? ids.offlineOff : undefined"
              data-action="download-cached"
              @click="run(downloadCached)"
            >
              Download without refreshing
            </button>
          </div>
          <div v-if="offline.remove" class="saved-list__remove">
            <button
              type="button"
              class="saved-list__btn"
              :class="confirm.armed(removeCopyId) ? 'armed-btn' : 'outline-btn'"
              :title="offline.remove.off ? withReason('Remove offline copy', offline.remove.off) : undefined"
              :disabled="!!offline.remove.off"
              :aria-describedby="offline.remove.off ? ids.removeCopyOff : undefined"
              data-action="remove-copy"
              :data-armed="confirm.armed(removeCopyId) || undefined"
              @click="removeCopy"
            >
              <span class="saved-list__remove-glyph i-tabler-trash" aria-hidden="true" />
              {{ confirm.armed(removeCopyId) ? 'Remove it?' : 'Remove offline copy' }}
            </button>
            <span class="saved-list__why" data-saved-list-note="remove-copy">{{ offline.remove.note }}</span>
            <span v-if="offline.remove.off" :id="ids.removeCopyOff" hidden>{{ sentence(offline.remove.off) }}.</span>
          </div>
        </template>
        <p v-else class="saved-list__dd saved-list__muted">
          {{ offline.empty }}
        </p>
      </section>

      <section :aria-label="`Tracking for ${name}`" class="saved-list__half">
        <h3 class="saved-list__dt">
          <span class="i-tabler-circle-check" aria-hidden="true" />Tracking
        </h3>
        <p v-if="tracking.state" class="saved-list__dd" :class="{ 'saved-list__muted': tracking.muted }">
          {{ tracking.state }}
        </p>
        <p v-if="tracking.what" class="saved-list__dd saved-list__muted">
          {{ tracking.what }}
        </p>
        <p v-if="tracking.problem" class="saved-list__note">
          <SeverityGlyph severity="destructive" class="saved-list__glyph" />
          <span>{{ tracking.problem }}</span>
        </p>
        <p v-if="viewEdit" class="saved-list__view-edit">
          <ArchiveLink :href="viewEdit" :aria-label="`View or edit ${name} on AO3`" data-action="view-edit">
            View/Edit
          </ArchiveLink>
          {{ ' ' }}<span class="saved-list__muted">{{ VIEW_EDIT_NOTE }}</span>
        </p>
        <!-- One button, tracking or stopping, so a press from the keyboard keeps its focus. -->
        <div v-if="tracking.action" :class="tracking.action.kind === 'stop' ? 'saved-list__remove' : 'saved-list__buttons'">
          <button
            type="button"
            class="saved-list__btn outline-btn"
            :title="withReason(tracking.action.kind === 'stop' ? 'Stop tracking this list; it stays a saved list' : 'Track this list for review', tracking.action.off)"
            :disabled="!!tracking.action.off"
            :aria-describedby="tracking.action.off ? ids.trackOff : undefined"
            :data-action="tracking.action.kind === 'stop' ? 'stop-tracking' : 'track'"
            @click="track(tracking.action?.kind === 'track')"
          >
            <span :class="tracking.action.kind === 'stop' ? 'i-tabler-circle-minus' : 'i-tabler-circle-check'" aria-hidden="true" />
            {{ tracking.action.kind === 'stop' ? 'Stop tracking' : 'Track this list' }}
          </button>
          <span v-if="tracking.action.note" class="saved-list__why">{{ tracking.action.note }}</span>
        </div>
        <div v-if="tracking.remove" class="saved-list__remove">
          <button
            type="button"
            class="saved-list__btn"
            :class="confirm.armed(removeListId) ? 'armed-btn' : 'outline-btn'"
            :title="tracking.remove.off ? withReason('Remove list', tracking.remove.off) : undefined"
            :disabled="!!tracking.remove.off"
            :aria-describedby="tracking.remove.off ? ids.removeListOff : undefined"
            data-action="remove-list"
            :data-armed="confirm.armed(removeListId) || undefined"
            @click="removeTheList"
          >
            <span class="saved-list__remove-glyph i-tabler-trash" aria-hidden="true" />
            {{ confirm.armed(removeListId) ? 'Remove it?' : 'Remove list' }}
          </button>
          <span class="saved-list__why" data-saved-list-note="remove-list">{{ tracking.remove.note }}</span>
          <span v-if="tracking.remove.off" :id="ids.removeListOff" hidden>{{ sentence(tracking.remove.off) }}.</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/*
  From a frame 840 px wide, four columns: the list, its status, its caching
  and its offline copy's controls, which share a left edge, with the chevron
  kept to the right. Narrower, the list and its status share a line, and the
  caching and the controls the next; narrower still, a phone's, the status
  stacks its switch over its word and the controls are glyphs a finger can
  find.
*/
/*
  The row's quieter words are `--quiet-fg`: muted, but the text colour at 57%
  under a job's brand tint, where muted is under AA in light. The job's line
  reads it too.
*/
.saved-list {
  --quiet-fg: rgb(var(--color-muted-fg));
  border-top: 1px solid rgb(var(--color-hair));
}
.saved-list:first-child {
  border-top-width: 0;
}
.saved-list--job {
  --quiet-fg: rgb(var(--color-default-fg) / 0.57);
  background-color: color-mix(in srgb, rgb(var(--color-brand-fg)) 4%, rgb(var(--color-default)));
}

.saved-list__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 168px 236px 128px;
  gap: 14px;
  align-items: center;
  min-height: 50px;
  padding: 7px 6px 7px 10px;
}
.saved-list:hover > .saved-list__row {
  background-color: var(--row-hover);
}

.saved-list__id {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
/* The field and the notes under it share one width, so a note wraps where the field ends. */
.saved-list__title,
.saved-list__id > .saved-list__note {
  max-width: 480px;
}
.saved-list__title {
  width: 100%;
  min-width: 0;
  height: 26px;
  padding: 0 7px;
  border: 1px solid rgb(var(--color-input));
  border-radius: 6px;
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-default-fg));
  font-size: 12.5px;
}
.saved-list__title::placeholder {
  color: rgb(var(--color-muted-fg));
  opacity: 1;
}
.saved-list__title[aria-invalid='true'] {
  border-color: rgb(var(--color-destructive));
}
.saved-list__name-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding-left: 8px;
  line-height: 26px;
}
.saved-list__name {
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.saved-list__name--raw {
  color: var(--quiet-fg);
  font-family: ui-monospace, SFMono-Regular, Consolas, Menlo, monospace;
  font-size: 11.5px;
}
.saved-list__open {
  flex: none;
  font-size: 11.5px;
}

.saved-list__what {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding-left: 8px;
  overflow: hidden;
  color: var(--quiet-fg);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.saved-list__what > * {
  flex: none;
}
.saved-list__what > .saved-list__trunc {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.saved-list__badge {
  padding: 0 4px;
  border: 1px solid rgb(var(--color-border));
  border-radius: 4px;
  color: rgb(var(--color-default-fg));
  font-size: 10.5px;
  font-weight: 600;
  line-height: 14px;
}
.saved-list__shared {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: rgb(var(--color-default-fg));
}
/*
  Copy URL: a small grey button with a badge's weight. Its words are the text
  colour at 57%, as a list header's are: muted-fg on this grey is under AA
  (4.5:1) in light.
*/
.saved-list__copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 16px;
  margin-left: 4px;
  padding: 0 5px 0 4px;
  border: 1px solid rgb(var(--color-border));
  border-radius: 4px;
  background-color: rgb(var(--color-secondary));
  color: rgb(var(--color-default-fg) / 0.57);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}
.saved-list__copy:hover {
  border-color: color-mix(in srgb, rgb(var(--color-muted-fg)) 45%, rgb(var(--color-border)));
  color: rgb(var(--color-default-fg));
}
.saved-list__copied {
  color: rgb(var(--color-success));
}

.saved-list__note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: rgb(var(--color-default-fg));
  font-size: 11.5px;
  line-height: 15px;
}
.saved-list__id > .saved-list__note {
  padding-left: 8px;
}
.saved-list__glyph {
  flex: none;
  margin-top: 1px;
  font-size: 13px;
}
.saved-list__shared .saved-list__glyph {
  margin-top: 0;
  font-size: 12px;
}

.saved-list__status,
.saved-list__caching {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.saved-list__status--off {
  opacity: 0.45;
}
.saved-list__no-switch {
  display: grid;
  flex: none;
  place-items: center;
  width: 26px;
  height: 24px;
  color: rgb(var(--color-muted-fg));
  font-size: 15px;
  opacity: 0.5;
}
.saved-list__lines {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 15px;
}
.saved-list__l1,
.saved-list__l2 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.saved-list__l1 {
  font-size: 12px;
}
.saved-list__l2 {
  color: var(--quiet-fg);
  font-size: 11px;
}
.saved-list__lines--muted .saved-list__l1 {
  color: var(--quiet-fg);
}
/* Wrapped rather than cut, so nothing clips the link's hit area on a phone. */
.saved-list__hint {
  overflow: visible;
  white-space: normal;
}
.saved-list__bar {
  flex: none;
  width: 52px;
  height: 5px;
}
.saved-list__bar--none {
  border-radius: 999px;
  background-color: rgb(var(--color-input));
}

.saved-list__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.saved-list__disclose {
  margin-left: auto;
}
.saved-list__disclose[aria-expanded='true'] > span {
  transform: rotate(180deg);
}
.saved-list__act,
.saved-list__btn {
  height: 26px;
  padding: 0 9px;
  font-size: 12px;
}
.saved-list__act--icon {
  justify-content: center;
  width: 26px;
  padding: 0;
}

.saved-list__job {
  padding: 0 12px 10px 18px;
}
.saved-list__discard {
  color: var(--quiet-fg);
}

.saved-list__details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0 6px 9px 10px;
  border: 1px solid rgb(var(--color-hair));
  border-radius: 9px;
  background-color: rgb(var(--color-sunken));
}
.saved-list__half {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  padding: 12px 14px 13px;
}
.saved-list__half + .saved-list__half {
  border-left: 1px solid rgb(var(--color-hair));
}
.saved-list__dt {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: rgb(var(--color-muted-fg));
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.saved-list__dd {
  margin: 0;
  font-size: 12px;
  line-height: 17px;
}
.saved-list__muted {
  color: rgb(var(--color-muted-fg));
}
.saved-list__buttons {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.saved-list__links {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 16px;
  font-size: 12px;
}
.saved-list__remove {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-top: 2px;
  padding-top: 9px;
  border-top: 1px solid rgb(var(--color-hair));
}
.saved-list__remove .saved-list__btn {
  flex: none;
}
.saved-list__remove-glyph {
  color: rgb(var(--color-destructive));
}
.saved-list__why {
  padding-top: 4px;
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
  line-height: 16px;
}
.saved-list__view-edit {
  margin: 0;
  font-size: 11.5px;
  line-height: 16px;
}
.saved-list__view-edit > a {
  margin-right: 6px;
  font-size: 12px;
}
.saved-list__link-btn {
  padding: 0;
  border: 0;
  background: none;
  color: rgb(var(--color-brand-fg));
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.saved-list__link-btn:disabled {
  cursor: default;
  opacity: 0.45;
}
.armed-btn > .saved-list__remove-glyph {
  color: inherit;
}

@container (max-width: 839px) {
  .saved-list__row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'id status'
      'caching actions';
    gap: 6px 10px;
    padding: 9px 6px 9px 8px;
  }
  .saved-list__id {
    grid-area: id;
  }
  .saved-list__status {
    grid-area: status;
    align-self: start;
  }
  .saved-list__caching {
    grid-area: caching;
    padding-left: 8px;
  }
  .saved-list__actions {
    grid-area: actions;
    justify-content: flex-end;
  }
  .saved-list__disclose {
    margin-left: 0;
  }
  /* Wrapped rather than cut, so nothing clips the hit areas of its links on a phone. */
  .saved-list__what {
    flex-wrap: wrap;
    row-gap: 1px;
    overflow: visible;
    white-space: normal;
  }
  .saved-list__remove {
    flex-direction: column;
    gap: 6px;
  }
  .saved-list__why {
    padding-top: 0;
  }
  .saved-list__details {
    grid-template-columns: minmax(0, 1fr);
    margin: 0 6px 9px 8px;
  }
  .saved-list__half + .saved-list__half {
    border-top: 1px solid rgb(var(--color-hair));
    border-left-width: 0;
  }
  .saved-list__job {
    padding: 0 10px 10px 16px;
  }
}

@container (max-width: 560px) {
  .saved-list__status {
    flex-direction: column;
    gap: 1px;
    align-items: center;
  }
  .saved-list__status .saved-list__lines {
    align-items: center;
  }
  .saved-list__status .saved-list__l1 {
    color: var(--quiet-fg);
    font-size: 10.5px;
  }
  .saved-list__status .saved-list__l2 {
    display: none;
  }
  .saved-list__status :deep(.icon-toggle),
  .saved-list__no-switch {
    width: 40px;
    height: 32px;
    border-radius: 8px;
  }
  .saved-list__act-label {
    display: none;
  }
  .saved-list__act,
  .saved-list__disclose {
    justify-content: center;
    width: 38px;
    height: 34px;
    padding: 0;
    border-radius: 8px;
  }
  .saved-list__btn {
    height: 34px;
    padding: 0 13px;
    border-radius: 8px;
    font-size: 13px;
  }
}
</style>
