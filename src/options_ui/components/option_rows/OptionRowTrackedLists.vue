<script setup lang="ts">
import type { SavedList, TrackedList } from '#common'

import { cache, defaultTitle, describeFilters, formatDay, getArchiveLink, isoDay, normalizeTrackedUrl, planRemoveList, planRetitle, planStopTracking, planTrack, refineLink, savedListsOf, sourceLabel, storedListRefs, toast, toEpochDays, TRACKED_TYPE_LABELS, trackedMeta, utcToday } from '#common'

import { useSavedLists } from '../../composables/useSavedLists.ts'
import { KIND_LABELS, titlePlaceholder } from '../../model/savedListRows.ts'

/**
 * Tracked lists: every saved list on this browser, each tracked or not, plus
 * the two numbers that shape a review — how many works a range aims for, and how
 * far the reader has already been. A tracked list's new and updated works are
 * gathered into one review stream, and only a tracked list syncs.
 *
 * Lists aren't created here. A list comes from the page it is (the floating
 * toolbar's "Track this search") or from a stored list further down the
 * options, because both of those know the address the review has to fetch;
 * this row is where one is retitled, tracked or not, and removed — and where
 * refining a tracked one starts: its row links to the list's own page, marked
 * as being refined ({@link refineLink}), and the floating toolbar there offers
 * to update it. Every change is a plan from `savedLists.ts`, applied to both
 * halves as they stand.
 */
const { enabled, target, reviewedThrough } = useOption('trackedLists')
const { entries, records, current, apply } = useSavedLists()
const { deleteCopies } = useSiteExport()

// ---------------------------------------------------------------------------
// Works per review
// ---------------------------------------------------------------------------

const TARGET_MIN = 10
const TARGET_MAX = 500

/**
 * Edited through a draft so a half-typed number is never the stored one: typing
 * "120" passes through "1", which clamped on the spot would become 10 and leave
 * the reader fighting the field. Clamped and written on blur or Enter instead.
 */
const targetDraft = ref(target.value)

watch(target, () => targetDraft.value = target.value)

function commitTarget() {
  const typed = Math.round(Number(targetDraft.value))
  const clamped = Number.isFinite(typed) ? Math.min(Math.max(typed, TARGET_MIN), TARGET_MAX) : TARGET_MIN
  targetDraft.value = clamped
  if (clamped !== target.value)
    target.value = clamped
}

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

/**
 * The latest day a reader may claim to have reviewed. A review range never
 * reaches today — the day isn't over, and marking it reviewed would bury every
 * work posted later today — so the picker doesn't offer it either.
 */
const latestReviewable = isoDay(utcToday() - 1)

const reviewedLabel = computed(() =>
  reviewedThrough.value > 0 ? formatDay(reviewedThrough.value) : 'Nothing reviewed yet',
)

function startChange() {
  dateDraft.value = reviewedThrough.value > 0 ? isoDay(reviewedThrough.value) : ''
  changingDate.value = true
}

/** An emptied field means "nothing reviewed yet", which is how a reader starts over. */
function commitDate() {
  const text = dateDraft.value.trim()
  if (!text) {
    reviewedThrough.value = 0
    changingDate.value = false
    return
  }
  const day = toEpochDays(text)
  // Half-entered dates arrive here from a picker being typed into; leave the
  // field open rather than writing a day nobody asked for.
  if (day === null)
    return
  reviewedThrough.value = Math.min(day, utcToday() - 1)
  changingDate.value = false
}

// ---------------------------------------------------------------------------
// The lists
// ---------------------------------------------------------------------------

/** A title as titles are compared: trimmed, in any case. */
function titleKey(title: string): string {
  return typeof title === 'string' ? title.trim().toLowerCase() : ''
}

/** A list as the title and label helpers read one: its title as an alias. */
function aliased(list: SavedList): Pick<TrackedList, 'id' | 'alias' | 'url' | 'type' | 'entity'> {
  return { id: list.id, alias: list.title, url: list.url, type: list.type, entity: list.entity }
}

/** A list by its title, and by what it is when the title doesn't say: “Mine” (Search: tea). */
function describe(list: Pick<TrackedList, 'id' | 'alias' | 'url' | 'type' | 'entity'>): string {
  const meta = trackedMeta(list)
  const title = sourceLabel(list)
  const what = meta && titleKey(defaultTitle(meta)) !== titleKey(title) ? ` (${defaultTitle(meta)})` : ''
  return `“${title}”${what}`
}

/**
 * What is typed in a title field, by list id, while it differs from what is
 * stored: a title still being typed, untrimmed, or one another list has, which
 * the field goes on showing, with the refusal under it, and which is saved
 * once it is free.
 */
const drafts = ref<Record<string, string>>({})

/**
 * The order the rows were in when a title field took focus. Rows sort by title,
 * so re-sorting as the reader types would move the field out from under them;
 * they hold still until focus leaves the titles altogether.
 */
const heldOrder = ref<string[] | null>(null)

const rows = computed(() => {
  const state = { tracked: { enabled: enabled.value, target: target.value, reviewedThrough: reviewedThrough.value, lists: entries.value }, saved: { lists: records.value } }
  const known = savedListsOf(state)
  const all = known.map(({ list }) => aliased(list))
  // Sync can bring two lists with one title together (made on two browsers
  // before they met). Marked, so the reader knows to rename one.
  const titleCounts = new Map<string, number>()
  for (const { list } of known) {
    const key = titleKey(list.title)
    if (key)
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }

  const built = known.map(({ list, entry }) => {
    /**
     * Null for a list whose address no longer reads as a page on the archive —
     * one that arrived through sync or an import from a build that knew a shape
     * this one doesn't, or that names another host entirely. Such a row is
     * flagged rather than linked, and the link is built from *this* rather than
     * from the stored text: a review carries the reader's session, so a link out
     * of the archive is the one thing this row must never offer.
     */
    const normalized = normalizeTrackedUrl(list.url)
    /**
     * The list's own page, marked as being refined: a tracked list's, since an
     * update from that page is an update to its entry. Null where the address
     * and the kind disagree.
     */
    const link = entry ? refineLink(list) : null
    const meta = trackedMeta(list)
    const draft = drafts.value[list.id]
    const plan = draft === undefined ? null : planRetitle(state, list.id, draft)
    return {
      id: list.id,
      /**
       * What the review's "List source" facet will call it, for labels and prompts
       * — disambiguated against every other list, so a name two lists share reads
       * here exactly as it will there, ` (2)` and all.
       */
      label: sourceLabel(aliased(list), all),
      titled: !!titleKey(list.title),
      /** What an emptied field shows: the default title it commits to. */
      placeholder: titlePlaceholder(list),
      /** What's in the field: the stored title, or what is being typed over it. */
      title: draft ?? list.title,
      refusal: plan && !plan.ok
        ? `Another list is already called ${describe(aliased(plan.takenBy))}, so this title isn't saved. Choose a different one.`
        : null,
      shared: (titleCounts.get(titleKey(list.title)) ?? 0) > 1,
      /** The type badge, so a list retitled to anything still says what it is. */
      type: meta ? TRACKED_TYPE_LABELS[meta.type] : null,
      /** The whole of what it is, for the badge's tooltip: "Character: Draco Malfoy". */
      what: meta ? defaultTitle(meta) : '',
      kind: KIND_LABELS[list.kind] ?? list.kind,
      /**
       * What it filters by, in a line: the archive's filters counted, since the
       * link opens them on screen, and the view's by name. Worded as the floating
       * toolbar words an update's changes, so the two read alike.
       */
      filters: describeFilters(list),
      broken: normalized === null,
      href: normalized && link ? getArchiveLink(link) : undefined,
      tracked: !!entry,
      state: entry ? `Tracking since ${formatDay(entry.since)}` : 'Saved',
    }
  })

  const held = heldOrder.value
  if (held) {
    // A list that arrived while the reader was typing goes at the end.
    const at = (id: string): number => {
      const index = held.indexOf(id)
      return index === -1 ? held.length : index
    }
    return built.sort((a, b) => at(a.id) - at(b.id))
  }
  // By title, which with the default "Type: …" titles also groups them by type.
  // Lists with no title of their own go last, under what the facet calls them.
  return built.sort((a, b) =>
    Number(!a.titled) - Number(!b.titled)
    || a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }))
})

/**
 * A title typed into a row, written straight through, trimmed: on the record,
 * and on the entry too while the list is tracked. A title another list has is
 * refused: it stays in the field, unsaved, with a line saying which list has it.
 */
function retitle(id: string, value: string) {
  drafts.value = { ...drafts.value, [id]: value }
  const before = current()
  const plan = planRetitle(before, id, value)
  if (plan.ok)
    apply(before, plan.state)
}

function holdOrder() {
  heldOrder.value ??= rows.value.map(row => row.id)
}

/**
 * Focus leaving a title: the rows may sort again, unless it went straight to
 * another title. The field shows the title as saved, trimmed — unless it was
 * refused and still is. A refused title that has since become free (the other
 * list was renamed meanwhile) is saved on the way out.
 */
function releaseOrder(id: string, event: FocusEvent) {
  const draft = drafts.value[id]
  if (draft !== undefined) {
    const before = current()
    const plan = planRetitle(before, id, draft)
    if (plan.ok) {
      apply(before, plan.state)
      const rest = { ...drafts.value }
      delete rest[id]
      drafts.value = rest
    }
  }
  const next = event.relatedTarget
  if (!(next instanceof HTMLElement && next.dataset.trackedTitle !== undefined))
    heldOrder.value = null
}

/**
 * Tracking starts the clock afresh, from today: a stretch spent untracked is
 * the reader saying "not these for now", so tracking again shouldn't pour back
 * everything they chose to skip. Stopping keeps the list, title and all, as a
 * saved list on this browser.
 */
function setTracked(id: string, on: boolean) {
  const before = current()
  if (!on) {
    apply(before, planStopTracking(before, id))
    return
  }
  const plan = planTrack(before, id, utcToday())
  if (plan.ok)
    apply(before, plan.state)
  else
    toast(`This search is already tracked as ${describe(plan.twin)}.`, { type: 'error' })
}

/** Removing a list loses its title, its tracking and its stored copies, so it asks first. */
const pendingDelete = ref<string | null>(null)
const pending = computed(() => rows.value.find(row => row.id === pendingDelete.value) ?? null)

/**
 * Remove the list: its record, its entry, and every copy stored at its address
 * unless another list there still claims them. The copies go first, so that no
 * moment has copies at an address with no record, which the background would
 * make an untitled list of.
 */
async function remove() {
  const id = pendingDelete.value
  pendingDelete.value = null
  if (id === null)
    return
  const { dropCopies } = planRemoveList(current(), id, storedListRefs(await cache.get('searchLists')))
  await deleteCopies(dropCopies)
  const before = current()
  apply(before, planRemoveList(before, id, []).state)
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Tracked lists"
    subtitle="Mark a search, an uncommon tag's works or a series as tracked, and everything new or updated across all of them is gathered into one review stream on your readings page. You look through a range of days, mark what deserves marking, then mark the range reviewed."
  >
    <div flex="~ col gap-3" mt-2>
      <p text="sm muted-fg">
        Nothing is ever marked reviewed one work at a time: a review is a range of days, and the only thing recorded is
        how far you have been. Works you have already marked read, or that are on your Marked for Later list, never
        appear — you have dealt with them already.
      </p>

      <div flex="~ col gap-3" border-t pt-3>
        <label flex="~ gap-3 items-center wrap">
          <span text="sm" min-w-40>Works per review</span>
          <NumberInput
            v-model="targetDraft"
            :min="TARGET_MIN"
            :max="TARGET_MAX"
            unit="works"
            aria-label="Works per review"
            @blur="commitTarget"
            @keydown.enter="commitTarget"
          />
          <span text="sm muted-fg">
            A range takes whole days until one more day would push it past this, so it is a target rather than a
            limit. {{ TARGET_MIN }}–{{ TARGET_MAX }}.
          </span>
        </label>

        <div flex="~ gap-3 items-center wrap">
          <span text="sm" min-w-40>Reviewed through</span>
          <template v-if="changingDate">
            <Input
              v-model="dateDraft"
              type="date"
              :max="latestReviewable"
              aria-label="Last day marked reviewed"
              text="base" h-9 py-2 pl-2
              @change="commitDate"
            />
            <Button variant="outline" size="sm" @click="commitDate">
              Save
            </Button>
            <Button variant="ghost" size="sm" @click="changingDate = false">
              Cancel
            </Button>
          </template>
          <template v-else>
            <span text="sm">{{ reviewedLabel }}</span>
            <Button variant="outline" size="sm" @click="startChange">
              Change…
            </Button>
          </template>
        </div>
        <p text="xs muted-fg">
          The next review starts the day after this. Move it back to review a range again, or forward to write off a
          backlog you are never going to read. Clearing the date starts from the day your earliest list was tracked.
        </p>
      </div>

      <div data-list="tracked-lists" flex="~ col gap-2" text="sm" border-t pt-3>
        <p v-if="!rows.length" text="sm muted-fg">
          No lists yet. Use <strong>Track this search</strong> in the floating toolbar on a search, a tag's works, or a
          series — or the <strong>Track</strong> button on a stored list under Advanced → Site export.
        </p>

        <div
          v-else
          grid="~ cols-[1fr_min-content_min-content]"
          items-start gap-x-4 gap-y-3
        >
          <span text="xs muted-fg uppercase tracking-wide">List</span>
          <span text="xs muted-fg uppercase tracking-wide" ws-nowrap>Tracked</span>
          <span />

          <div v-for="row in rows" :key="row.id" :data-list-row="row.id" contents>
            <span flex="~ col gap-1" min-w-0>
              <Input
                :model-value="row.title"
                type="text"
                :placeholder="row.placeholder"
                :aria-label="`Title for ${row.label}`"
                :aria-invalid="row.refusal ? 'true' : undefined"
                data-tracked-title
                text="base" h-9 w-full py-2 pl-2
                @update:model-value="retitle(row.id, String($event))"
                @focus="holdOrder"
                @blur="releaseOrder(row.id, $event)"
              />
              <span v-if="row.refusal" text="xs destructive" role="alert">{{ row.refusal }}</span>
              <span v-else-if="row.shared" text="xs destructive">
                Another list has this title too. Rename one of them so they can be told apart.
              </span>
              <span flex="~ gap-1 items-center wrap" text="xs muted-fg">
                <span
                  v-if="row.type"
                  :title="row.what"
                  border rounded px-1.5 font-medium text="default-fg"
                >{{ row.type }}</span>
                <span>{{ row.kind }}</span>
                <span aria-hidden="true">·</span>
                <span>{{ row.state }}</span>
                <template v-if="row.href">
                  <span aria-hidden="true">·</span>
                  <ArchiveLink
                    :href="row.href"
                    title="Open this list's search to refine it"
                    :aria-label="`Open the search for ${row.label} on AO3, to refine it`"
                  >
                    Refine on AO3
                  </ArchiveLink>
                </template>
              </span>
              <!--
                One line, however narrow the page: what the summary had to leave
                out, or the page's width cuts off, is in the tooltip. A screen
                reader gets the whole of it in place of the shortened line.
              -->
              <span
                v-if="row.filters.text"
                :title="row.filters.full"
                data-tracked-filters
                truncate text="xs muted-fg"
              >
                <template v-if="row.filters.more">
                  <span aria-hidden="true">{{ row.filters.text }}</span>
                  <span class="sr-only">{{ row.filters.full }}</span>
                </template>
                <template v-else>{{ row.filters.text }}</template>
              </span>
              <span v-if="row.broken" text="xs destructive">
                This address isn't a page on AO3, so it can't be reviewed. Remove it and track the list again from the
                page itself.
              </span>
            </span>
            <Switch
              :model-value="row.tracked"
              title="Track this list"
              :aria-label="`Track ${row.label}`"
              @update:model-value="setTracked(row.id, $event)"
            />
            <Button
              variant="outline"
              size="icon"
              @click.prevent="pendingDelete = row.id"
            >
              <Icon i-mdi-trash-can-outline :label="`Remove ${row.label}`" />
            </Button>
          </div>
        </div>

        <p text="xs muted-fg">
          The title is yours to set — it is what the review's "List source" filter calls the list, so no two lists can
          share one. A new list starts out named for what it searches, such as "Character: Draco Malfoy". Switching
          tracking off keeps the list, and its title, as a saved list on this browser: it stops being reviewed, and
          stops syncing to your other browsers. Switching it back on tracks it again from today, so the gap isn't
          filled in.
        </p>
        <p text="xs muted-fg">
          To change what a tracked list searches, use <strong>Refine on AO3</strong>: it opens the list's search, and
          once you have changed it — the Sort &amp; Filter sidebar, the search form — the floating toolbar there offers
          to update the list, which keeps its place in your review.
        </p>
      </div>
    </div>

    <Dialog :open="!!pending" @update:open="(open) => { if (!open) pendingDelete = null }">
      <DialogContent>
        <DialogTitle>
          Remove this list?
        </DialogTitle>
        <DialogDescription pt-2>
          <strong>{{ pending?.label }}</strong> is removed from this browser: its title, its tracking, and its stored
          copies, unless another list searches the same thing. Cached work text stays. To keep the list without
          reviewing it, switch tracking off instead.
        </DialogDescription>
        <div flex="~ row justify-end gap-2" pt-4>
          <Button variant="outline" @click.prevent="pendingDelete = null">
            Cancel
          </Button>
          <Button variant="destructive" @click.prevent="remove">
            Remove list
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </OptionRowCollapsable>
</template>
