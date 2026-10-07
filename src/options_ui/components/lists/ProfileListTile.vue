<script setup lang="ts">
import { getArchiveLink } from '#common'

import type { SiteExportListRow } from '../../composables/useSiteExport.ts'
import type { ProfileListId, ProfileTileView } from '../../model/profileLists.ts'

import { sentence, withReason } from '../../model/phrases.ts'
import { blurbsOnRemove } from '../../model/savedListRows.ts'

/**
 * One of the reader's own profile lists, as a tile: what it is, its offline
 * copy's figures, and what can be done with the copy. The job, when it is on
 * this list, takes the actions' place, with what it offers for itself.
 *
 * Every control that is off says why, in its tooltip and its description, and
 * the reason is said in the tile as well, where the reader is looking.
 *
 * It is found by the settings search, and has an anchor, as a settings row
 * does: by its name and its note.
 */
const props = defineProps<{
  tile: ProfileTileView
  /** The copy the tile is of; null with none. */
  row: SiteExportListRow | null
  /** The stored lists are still being read, so a missing copy may only be late. */
  loading: boolean
}>()

const { refreshList, cacheWorks, refreshAndCache, downloadSite, downloadCached, deleteList, stop, resume, discard } = useSiteExport()

const { id, visible, titleHtml, subtitleHtml } = useSearchableRow(() => ({ title: props.tile.name, subtitle: props.tile.note }))

const ICONS: Record<ProfileListId, string> = {
  'marked-for-later': 'i-tabler-bookmark',
  'read-works': 'i-tabler-book',
}

const view = computed(() => (props.tile.view ? getArchiveLink(props.tile.view) : null))

const offlineOffId = useId()

const refreshLabel = computed(() => `Refresh the list of works in ${props.tile.name}`)
const cacheLabel = computed(() => (props.tile.cached ? 'Update the cached works' : 'Cache this list\'s works'))
const downloadLabel = 'Refresh, cache, then save this list as one HTML file'

/** Whether removing the copy takes its blurbs now, which the menu says. */
const prune = useOption('pruneOrphanedBlurbs')

/** Removing the copy asks a second time in its own place, with the menu left open between the two. */
const confirm = useConfirmInPlace()
const removeId = computed(() => `remove-copy:${props.row?.key ?? props.tile.id}`)

function remove(event: Event): void {
  if (!props.row)
    return
  if (!confirm.press(removeId.value)) {
    event.preventDefault()
    return
  }
  void deleteList(props.row)
}

/**
 * The menu's items: a name and a line on what it does. The menu is drawn
 * outside the tile, where the tile's own styles don't reach, so these are
 * utility classes. Armed, Remove fills with the destructive colour.
 */
const ITEM = 'flex flex-col items-start gap-0.5 px-[11px] py-2'
const NAME = 'text-[12.5px] font-500 leading-[17px]'
const NOTE = 'text-[11.5px] leading-4 text-muted-fg'
const ARMED = '!bg-destructive !text-destructive-fg [&>*]:!text-destructive-fg'

/** Run one of the copy's jobs. */
function run(start: (row: SiteExportListRow) => unknown): void {
  if (props.row)
    void start(props.row)
}
</script>

<template>
  <article
    v-show="visible"
    :id="id"
    :data-tile="tile.id"
    class="tile"
    :class="{ 'tile--job': tile.job }"
    :aria-label="tile.name"
    style="scroll-margin-top: var(--shell-top);"
  >
    <div class="tile__head">
      <span class="tile__icon" aria-hidden="true"><span :class="ICONS[tile.id]" /></span>
      <div min-w-0>
        <div class="tile__name">
          <!-- v-html is safe here: `highlight` escapes the text and only ever adds <mark>. -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-html="titleHtml" />{{ ' ' }}<Badge data-badge="needs-login" title="Only visible to your own account, so it is fetched only while you are signed in to AO3" ml-1>
            Needs login
          </Badge>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <p class="tile__note" v-html="subtitleHtml" />
      </div>
      <a
        v-if="view"
        :href="view"
        target="_blank"
        rel="noopener noreferrer"
        class="icon-btn"
        :aria-label="`View ${tile.name} on AO3`"
        title="View on AO3"
      >
        <span class="i-tabler-external-link" text="[15px]" aria-hidden="true" />
      </a>
    </div>

    <p v-if="tile.empty && !loading" class="tile__empty">
      {{ tile.empty }}
    </p>

    <template v-if="tile.figure && tile.figures">
      <div class="tile__figure">
        <b>{{ tile.figure.count }}</b>{{ ' ' }}<span>{{ tile.figure.detail }}</span>
      </div>
      <!-- The job's own bar stands in for the copy's while the job is here. -->
      <BucketBar v-if="tile.bar && !tile.job" :bar="tile.bar" />
      <div class="tile__legend">
        <span>
          <span v-if="!tile.job" class="tile__key tile__key--cached" aria-hidden="true" />
          <b>{{ tile.figures.cached }}</b> cached ({{ tile.figures.size }})
        </span>
        <span v-if="tile.figures.uncached">
          <span v-if="!tile.job" class="tile__key tile__key--uncached" aria-hidden="true" />
          <b>{{ tile.figures.uncached }}</b> uncached<template v-if="tile.figures.failed">
            · <b>{{ tile.figures.failed }}</b> failed
          </template>
        </span>
      </div>
    </template>

    <SiteExportProgress v-if="tile.job">
      <template v-if="tile.actions !== 'offline'" #foot>
        <button v-if="tile.actions === 'stop'" type="button" class="outline-btn small-btn" @click="stop()">
          <span class="i-tabler-player-stop" aria-hidden="true" />
          Stop
        </button>
        <template v-else>
          <button type="button" class="primary-btn small-btn" @click="resume()">
            <span class="i-tabler-player-play" aria-hidden="true" />
            Continue
          </button>
          <button type="button" class="ghost-btn small-btn" @click="discard()">
            Discard
          </button>
        </template>
      </template>
    </SiteExportProgress>

    <!-- Said where the reader is looking, beside the buttons it turns off. -->
    <p v-if="tile.offlineOff" class="tile__off">
      <SeverityGlyph severity="neutral" shrink-0 />
      <span :id="offlineOffId">{{ sentence(tile.offlineOff) }}.</span>
    </p>

    <div v-if="tile.actions === 'offline'" class="tile__actions">
      <button
        type="button"
        class="outline-btn small-btn"
        :title="withReason(refreshLabel, tile.offlineOff)"
        :disabled="!!tile.offlineOff"
        :aria-describedby="tile.offlineOff ? offlineOffId : undefined"
        @click="run(refreshList)"
      >
        <span class="i-tabler-refresh" aria-hidden="true" />
        Refresh list
      </button>
      <button
        type="button"
        class="outline-btn small-btn"
        :title="withReason(cacheLabel, tile.offlineOff)"
        :disabled="!!tile.offlineOff"
        :aria-describedby="tile.offlineOff ? offlineOffId : undefined"
        @click="run(cacheWorks)"
      >
        <span class="i-tabler-cloud-download" aria-hidden="true" />
        Cache works
      </button>
      <button
        type="button"
        class="outline-btn small-btn"
        :title="withReason(downloadLabel, tile.offlineOff)"
        :disabled="!!tile.offlineOff"
        :aria-describedby="tile.offlineOff ? offlineOffId : undefined"
        @click="run(downloadSite)"
      >
        <span class="i-tabler-download" aria-hidden="true" />
        Download Offline Copy
      </button>
      <span class="tile__spacer" />
      <DropdownMenu :modal="false">
        <DropdownMenuTrigger>
          <button
            type="button"
            class="icon-btn"
            :aria-label="`More for ${tile.name}`"
            title="Refresh the list first, retry failed works, download without refreshing, remove"
          >
            <span class="i-tabler-dots" text="[16px]" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="max-w-[calc(100vw-32px)] w-[310px] p-[5px]">
          <DropdownMenuItem
            :disabled="!!tile.offlineOff"
            :title="withReason('Refresh the list first', tile.offlineOff)"
            :aria-describedby="tile.offlineOff ? offlineOffId : undefined"
            :class="ITEM"
            @select="run(refreshAndCache)"
          >
            <span :class="NAME">Refresh the list first</span>
            <span :class="NOTE">
              Re-scrape the list, then cache against it. Slower, and the only way the
              &ldquo;has this work changed?&rdquo; check can be accurate.
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="tile.retry"
            :disabled="!!tile.offlineOff"
            :title="withReason('Retry failed works now', tile.offlineOff)"
            :aria-describedby="tile.offlineOff ? offlineOffId : undefined"
            :class="ITEM"
            @select="row && cacheWorks(row, { retryNow: true })"
          >
            <span :class="NAME">Retry failed works now</span>
            <span :class="NOTE">
              Don't wait out the retry delay on the {{ tile.retry.toLocaleString() }}
              {{ tile.retry === 1 ? 'work' : 'works' }} that failed &mdash; for after signing back in to AO3.
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="tile.cached"
            :disabled="!!tile.offlineOff"
            :title="withReason('Download without refreshing', tile.offlineOff)"
            :aria-describedby="tile.offlineOff ? offlineOffId : undefined"
            :class="ITEM"
            @select="run(downloadCached)"
          >
            <span :class="NAME">Download without refreshing</span>
            <span :class="NOTE">
              Package exactly what is saved here now, without asking AO3 for anything. Quick, and as up to date as
              the {{ tile.cached.toLocaleString() }} saved {{ tile.cached === 1 ? 'work' : 'works' }} are.
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem :class="[ITEM, confirm.armed(removeId) ? ARMED : '']" @select="remove">
            <span :class="NAME">{{ confirm.armed(removeId) ? 'Remove offline copy?' : 'Remove offline copy' }}</span>
            <span :class="NOTE">
              Opening the list on AO3 keeps a copy again. Its cached work text stays. {{ blurbsOnRemove(prune) }}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </article>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  gap: 11px;
  min-width: 0;
  padding: 13px 13px 14px;
  border: 1px solid rgb(var(--color-border));
  border-radius: 10px;
  background-color: rgb(var(--color-default));
}
@media (min-width: 768px) {
  .tile {
    padding: 14px 16px 15px;
  }
}
.tile--job {
  border-color: rgb(var(--color-brand-fg) / 0.32);
}

.tile__head {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
}
.tile__icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background-color: rgb(var(--color-muted));
  color: rgb(var(--color-brand-fg));
  font-size: 17px;
}
.tile__name {
  font-size: 14px;
  font-weight: 600;
  line-height: 19px;
}
.tile__note {
  margin: 2px 0 0;
  color: rgb(var(--color-muted-fg));
  font-size: 12px;
  line-height: 17px;
}
.tile__empty {
  margin: 0;
  color: rgb(var(--color-muted-fg));
  font-size: 12px;
  line-height: 17px;
}

/* One line of text, the count and what it counts on a shared baseline. */
.tile__figure {
  line-height: 26px;
}
.tile__figure b {
  margin-right: 4px;
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tile__figure span {
  color: rgb(var(--color-muted-fg));
  font-size: 12px;
}
.tile__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
}
.tile__legend b {
  color: rgb(var(--color-default-fg));
  font-weight: 600;
}
.tile__key {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 2px;
}
.tile__key--cached {
  background-color: rgb(var(--color-muted-fg));
}
.tile__key--uncached {
  background-color: rgb(var(--color-input));
}

.tile__off {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
  line-height: 15px;
}
.tile__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.tile__spacer {
  flex: 1;
}
</style>
