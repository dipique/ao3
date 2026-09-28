<script setup lang="ts">
import type { TrackedKind, TrackedList } from '#common'

import { defaultTitle, describeFilters, formatDay, getArchiveLink, isoDay, normalizeTrackedUrl, refineLink, sourceLabel, titleTakenBy, toEpochDays, TRACKED_TYPE_LABELS, trackedMeta, utcToday } from '#common'

/**
 * Tracked lists: the saved queries whose new and updated works are gathered into
 * one review stream, plus the two numbers that shape a review — how many works a
 * range aims for, and how far the reader has already been.
 *
 * Entries aren't created here. A list becomes tracked from the page it is (the
 * floating toolbar's "Track this search") or from a stored list further down the
 * options, because both of those know the address the review has to fetch; this
 * row is where one is retitled, paused, and dropped — and where refining one
 * starts: each row links to the list's own page, marked as being refined
 * ({@link refineLink}), and the floating toolbar there offers to update it.
 */
const { enabled, target, reviewedThrough, lists } = useOption('trackedLists')

/** What each kind of query is called in the reader's words. */
const KIND_LABELS: Record<TrackedKind, string> = {
  'works-filter': 'Filtered listing',
  'text-search': 'Works search',
  'tag-works': 'Uncommon tag',
  'series-works': 'Series',
}

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

/**
 * Titles typed here that another list already has, by list id. The field keeps
 * showing what was typed, with the refusal under it, and nothing is saved until
 * the title is one no other list has.
 */
const refusedTitles = ref<Record<string, string>>({})

/** Say which list has the title: by its title, and by what it is when the title doesn't say. */
function refusal(other: TrackedList | null): string | null {
  if (!other)
    return null
  const meta = trackedMeta(other)
  const what = meta && titleKey(defaultTitle(meta)) !== titleKey(other.alias) ? ` (${defaultTitle(meta)})` : ''
  return `Another list is already called “${other.alias.trim()}”${what}, so this title isn't saved. Choose a different one.`
}

/**
 * The order the rows were in when a title field took focus. Rows sort by title,
 * so re-sorting as the reader types would move the field out from under them;
 * they hold still until focus leaves the titles altogether.
 */
const heldOrder = ref<string[] | null>(null)

const rows = computed(() => {
  const all = lists.value
  // Sync can bring two lists with one title together (made on two browsers
  // before they met). Marked, so the reader knows to rename one.
  const titleCounts = new Map<string, number>()
  for (const entry of all) {
    const key = titleKey(entry.alias)
    if (key)
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }

  const built = all.map((entry) => {
    /**
     * Null for an entry whose address no longer reads as a page on the archive —
     * one that arrived through sync or an import from a build that knew a shape
     * this one doesn't, or that names another host entirely. Such a row is
     * flagged rather than linked, and the link is built from *this* rather than
     * from the stored text: a review carries the reader's session, so a link out
     * of the archive is the one thing this row must never offer.
     */
    const normalized = normalizeTrackedUrl(entry.url)
    /** The list's own page, marked as being refined. Null where the address and the kind disagree. */
    const link = refineLink(entry)
    const meta = trackedMeta(entry)
    const refused = refusedTitles.value[entry.id]
    return {
      entry,
      /**
       * What the review's "List source" facet will call it, for labels and prompts
       * — disambiguated against every other entry, so a name two lists share reads
       * here exactly as it will there, ` (2)` and all.
       */
      label: sourceLabel(entry, all),
      /** The tail of the URL — what the facet falls back to when there's no title. */
      placeholder: sourceLabel({ id: entry.id, alias: '', url: entry.url }),
      /** What's in the field: the stored title, or a refused one still being typed. */
      title: refused ?? entry.alias,
      refusal: refused === undefined ? null : refusal(titleTakenBy(refused, all, entry.id)),
      shared: (titleCounts.get(titleKey(entry.alias)) ?? 0) > 1,
      /** The type badge, so a list retitled to anything still says what it is. */
      type: meta ? TRACKED_TYPE_LABELS[meta.type] : null,
      /** The whole of what it is, for the badge's tooltip: "Character: Draco Malfoy". */
      what: meta ? defaultTitle(meta) : '',
      kind: KIND_LABELS[entry.kind] ?? entry.kind,
      /**
       * What it filters by, in a line: the archive's filters counted, since the
       * link opens them on screen, and the view's by name. Worded as the floating
       * toolbar words an update's changes, so the two read alike.
       */
      filters: describeFilters(entry),
      broken: normalized === null,
      href: normalized && link ? getArchiveLink(link) : undefined,
      state: entry.tracked ? `Tracking since ${formatDay(entry.since)}` : 'Paused',
    }
  })

  const held = heldOrder.value
  if (held) {
    // A list that arrived while the reader was typing goes at the end.
    const at = (id: string): number => {
      const index = held.indexOf(id)
      return index === -1 ? held.length : index
    }
    return built.sort((a, b) => at(a.entry.id) - at(b.entry.id))
  }
  // By title, which with the default "Type: …" titles also groups them by type.
  // Lists with no title of their own go last, under what the facet calls them.
  return built.sort((a, b) =>
    Number(!a.entry.alias.trim()) - Number(!b.entry.alias.trim())
    || a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }))
})

/**
 * A title typed into a row. Written straight through — unless another list has
 * it, which is refused: it stays in the field, unsaved, with a line saying which
 * list has it.
 */
function retitle(entry: TrackedList, value: string) {
  const next = { ...refusedTitles.value }
  if (titleTakenBy(value, lists.value, entry.id)) {
    next[entry.id] = value
    refusedTitles.value = next
    return
  }
  delete next[entry.id]
  refusedTitles.value = next
  entry.alias = value
}

function holdOrder() {
  heldOrder.value ??= rows.value.map(row => row.entry.id)
}

/**
 * Focus leaving a title: the rows may sort again, unless it went straight to
 * another title. A refused title that has since become free — the other list was
 * renamed meanwhile — is saved on the way out.
 */
function releaseOrder(entry: TrackedList, event: FocusEvent) {
  const refused = refusedTitles.value[entry.id]
  if (refused !== undefined && !titleTakenBy(refused, lists.value, entry.id))
    retitle(entry, refused)
  const next = event.relatedTarget
  if (!(next instanceof HTMLElement && next.dataset.trackedTitle !== undefined))
    heldOrder.value = null
}

/**
 * Resuming restarts the clock. A paused stretch is the reader saying "not these
 * for now", so resuming shouldn't pour back everything they chose to skip.
 */
function setTracked(entry: TrackedList, on: boolean) {
  entry.tracked = on
  if (on)
    entry.since = utcToday()
}

/** Dropping a list loses its alias and its tracking date, so it asks first. */
const pendingDelete = ref<string | null>(null)
const pending = computed(() => rows.value.find(row => row.entry.id === pendingDelete.value) ?? null)

function remove() {
  const id = pendingDelete.value
  pendingDelete.value = null
  const at = lists.value.findIndex(entry => entry.id === id)
  if (at !== -1)
    lists.value.splice(at, 1)
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

      <div flex="~ col gap-2" text="sm" border-t pt-3>
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

          <template v-for="row in rows" :key="row.entry.id">
            <span flex="~ col gap-1" min-w-0>
              <Input
                :model-value="row.title"
                type="text"
                :placeholder="row.placeholder"
                :aria-label="`Title for ${row.label}`"
                :aria-invalid="row.refusal ? 'true' : undefined"
                data-tracked-title
                text="base" h-9 w-full py-2 pl-2
                @update:model-value="retitle(row.entry, $event)"
                @focus="holdOrder"
                @blur="releaseOrder(row.entry, $event)"
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
              :model-value="row.entry.tracked"
              title="Track this list"
              :aria-label="`Track ${row.label}`"
              @update:model-value="setTracked(row.entry, $event)"
            />
            <Button
              variant="outline"
              size="icon"
              @click.prevent="pendingDelete = row.entry.id"
            >
              <Icon i-mdi-trash-can-outline :label="`Remove ${row.label}`" />
            </Button>
          </template>
        </div>

        <p text="xs muted-fg">
          The title is yours to set — it is what the review's "List source" filter calls the list, so no two lists can
          share one. A new list starts out named for what it searches, such as "Character: Draco Malfoy". Switching a
          list off keeps it, and its title, and simply stops reviewing it; switching it back on starts tracking again
          from today, so the gap isn't filled in.
        </p>
        <p text="xs muted-fg">
          To change what a list searches, use <strong>Refine on AO3</strong>: it opens the list's search, and once you
          have changed it — the Sort &amp; Filter sidebar, the search form — the floating toolbar there offers to
          update the list, which keeps its place in your review.
        </p>
      </div>
    </div>

    <Dialog :open="!!pending" @update:open="(open) => { if (!open) pendingDelete = null }">
      <DialogContent>
        <DialogTitle>
          Remove this list?
        </DialogTitle>
        <DialogDescription pt-2>
          <strong>{{ pending?.label }}</strong> stops being tracked, and the title and tracking date it had are
          gone. Nothing stored for the list itself is deleted. Tracking it again starts from the day you do that, so
          anything it turns up between now and then is not reviewed.
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
