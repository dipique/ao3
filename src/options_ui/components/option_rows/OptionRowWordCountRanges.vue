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

function add() {
  drafts.value.push({ from: '', to: '' })
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
    <div flex="~ col gap-3" pt-2>
      <p text="sm muted-fg">
        Clicking (or right-clicking) the word count in a work's stats opens a menu of these ranges, plus a row
        clearing the range currently applied. On a normal listing the pick fills AO3's own Word Count filter and
        re-runs the search; inside “Search Marked for Later” it filters the loaded list instead.
      </p>

      <p v-if="drafts.length === 0" text="sm muted-fg">
        No ranges yet. Add one to offer it in the menu.
      </p>

      <div
        v-for="(draft, index) in drafts"
        :key="index"
        flex="~ col gap-1"
        border rounded-md p-3
      >
        <div flex="~ gap-2 items-center wrap">
          <Input
            v-model="draft.from"
            type="text"
            inputmode="numeric"
            placeholder="No minimum"
            aria-label="Lowest word count"
            text="base" h-9 min-w-32 flex-1 py-2 pl-2
          />
          <span shrink-0 text="sm muted-fg">to</span>
          <Input
            v-model="draft.to"
            type="text"
            inputmode="numeric"
            placeholder="No maximum"
            aria-label="Highest word count"
            text="base" h-9 min-w-32 flex-1 py-2 pl-2
          />
          <span shrink-0 text="sm muted-fg">words</span>
          <button
            class="input-ring"
            text="4 muted-fg hover:default-fg"
            shrink-0 cursor-pointer rounded-md p-1
            title="Remove this range"
            @click="remove(index)"
          >
            <Icon i-codicon-trash label="Remove" />
          </button>
        </div>
        <p v-if="errors[index]" text="sm destructive" pl-1>
          {{ errors[index] }}
        </p>
        <p v-else-if="parsed[index]" text="xs muted-fg" pl-1>
          Shown as “{{ formatWordCountRange(parsed[index]!) }} words”.
        </p>
      </div>

      <p text="xs muted-fg" pl-1>
        Leave a box empty for an open-ended range — “5000” to nothing offers “5,000+”. Ranges may overlap; only
        exact duplicates are rejected.
      </p>

      <div>
        <Button variant="outline" text="sm" @click="add">
          <Icon i-mdi-plus mr-1 label="Add" /> Add range
        </Button>
      </div>
    </div>
  </OptionRowCollapsable>
</template>
