<script setup lang="ts">
import type { WordCountRange } from '#common'

import { duplicateOf, formatWordCountRange, parseBoundInput, rangeError } from '#common'

const { enabled, ranges } = useOption('wordCountToolbar')

/**
 * The rows are edited as text so a half-typed bound ("1" on the way to "1000")
 * and a deliberately blank one ("no upper bound") are both representable —
 * neither is a number we'd want to write straight into the option. Drafts are
 * seeded from the saved list and only written back once every row parses and
 * passes {@link rangeError}, so an in-progress edit can never leave a broken
 * range where the menu would read it.
 */
interface Draft {
  from: string
  to: string
}

function toDraft(range: WordCountRange): Draft {
  return {
    from: range.from == null ? '' : String(range.from),
    to: range.to == null ? '' : String(range.to),
  }
}

const drafts = ref<Draft[]>(ranges.value.map(toDraft))

/** One draft row parsed into bounds, or null when a bound isn't a whole number. */
function parseDraft(draft: Draft): WordCountRange | null {
  const from = parseBoundInput(draft.from)
  const to = parseBoundInput(draft.to)
  if (from === undefined || to === undefined)
    return null
  return { from, to }
}

const parsed = computed(() => drafts.value.map(parseDraft))

const errors = computed(() => parsed.value.map((range, index) => {
  if (!range)
    return 'Word counts must be whole numbers of 0 or more.'
  const error = rangeError(range)
  if (error)
    return error
  // Overlaps are fine — two ranges can legitimately both match a work — but an
  // exact repeat would just be the same menu row twice.
  // Unparseable rows get a sentinel no real range can equal, so they never
  // read as a duplicate of (or for) a row that does parse.
  const comparable = parsed.value.map(r => r ?? { from: -1, to: -1 })
  return duplicateOf(comparable, index) === -1 ? '' : 'This range is already in the list.'
}))

const valid = computed(() => errors.value.every(error => !error))

// Adopt changes made elsewhere (another device via sync, a reset), but never
// while the user has an unsaved/invalid edit in front of them.
watch(ranges, (next) => {
  if (!valid.value)
    return
  const incoming = next.map(toDraft)
  if (JSON.stringify(incoming) !== JSON.stringify(drafts.value))
    drafts.value = incoming
}, { deep: true })

// Write the whole list at once, and only when it is entirely valid — a partial
// write would mean the menu briefly offered a range the user is mid-way through
// replacing.
watch([parsed, valid], () => {
  if (!valid.value)
    return
  const next = parsed.value as WordCountRange[]
  if (JSON.stringify(next) !== JSON.stringify(ranges.value))
    ranges.value = next.map(range => ({ ...range }))
}, { deep: true })

/**
 * Each row is the two bounds, the label they make or the error that stops
 * them, and Remove. In a narrow frame the label takes a line of its own.
 */
const ROW = '"identity meta actions" / 226px minmax(0, 1fr) 28px'
const NARROW_ROW = '"identity actions" "meta ." / minmax(0, 1fr) 28px'

const frame = useTemplateRef('frame')

async function add() {
  drafts.value.push({ from: '', to: '' })
  await nextTick()
  frame.value?.reveal(drafts.value.length - 1)
}

function remove(index: number) {
  drafts.value.splice(index, 1)
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Word count menu"
    subtitle="Click a work’s word count in a listing for a menu of lengths to filter by. Edit the ranges it offers below; they may overlap."
  >
    <div flex="~ col gap-3">
      <ListNote>
        A pick fills AO3’s Word Count filter and searches again, or filters an instant search view in place; the menu
        can clear it too. A blank bound is open-ended; only an exact repeat is refused.
      </ListNote>

      <ListFrame
        ref="frame"
        list-id="word-count-ranges"
        title="Word count ranges"
        :count="drafts.length ? String(drafts.length) : 'none yet'"
        :empty="drafts.length === 0"
        add-label="Add a range"
        class="max-w-[540px]"
        @add="add"
      >
        <template #empty>
          <b>No ranges yet</b>
          Add one to offer it in the menu.
        </template>

        <ListRow
          v-for="(draft, index) in drafts"
          :key="index"
          :row-id="index"
          :template="ROW"
          :narrow-template="NARROW_ROW"
          :error="errors[index]"
        >
          <div class="grid grid-cols-[minmax(0,1fr)_18px_minmax(0,1fr)] items-center gap-2">
            <Input
              v-model="draft.from"
              type="text"
              inputmode="numeric"
              placeholder="No min"
              aria-label="Lowest word count"
              class="h-[22px] w-full px-[7px] text-[12.5px] tabular-nums"
            />
            <span class="text-center text-muted-fg">to</span>
            <Input
              v-model="draft.to"
              type="text"
              inputmode="numeric"
              placeholder="No max"
              aria-label="Highest word count"
              class="h-[22px] w-full px-[7px] text-[12.5px] tabular-nums"
            />
          </div>
          <template v-if="parsed[index]" #meta>
            “{{ formatWordCountRange(parsed[index]!) }} words”
          </template>
          <template #actions>
            <button
              type="button"
              class="icon-btn"
              aria-label="Remove range"
              title="Remove range"
              @click="remove(index)"
            >
              <span class="i-tabler-trash" text="sm" aria-hidden="true" />
            </button>
          </template>
        </ListRow>
      </ListFrame>
    </div>
  </OptionRowCollapsable>
</template>
