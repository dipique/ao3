<script setup lang="ts" generic="K extends string">
import type { KeySort } from '../../model/listView.ts'

import { cycleSort, sortHint, sortState } from '../../model/listView.ts'

/**
 * A list's sort by one of its keys, for its frame's header: a glyph button
 * named for the sort the list shows, opening a menu of the keys. A key pressed
 * in turn sorts ascending, descending, then not at all ({@link cycleSort}).
 * The menu stays open on a press, so the cycle can be stepped through, and
 * each key shows where it is in it, with what its next press does as its
 * tooltip.
 */
const props = defineProps<{
  choices: readonly { value: K, label: string }[]
}>()

const sort = defineModel<KeySort<K>>({ required: true })

const name = computed(() => {
  const by = props.choices.find(choice => choice.value === sort.value.key)
  return by ? `Sort: ${by.label}, ${sortState(sort.value, by.value)}` : 'Sort: none'
})

function itemName(choice: { value: K, label: string }) {
  const state = sortState(sort.value, choice.value)
  return state === 'none' ? choice.label : `${choice.label}, sorted ${state}`
}

function press(event: Event, key: K) {
  event.preventDefault()
  sort.value = cycleSort(sort.value, key)
}
</script>

<template>
  <DropdownMenu :modal="false">
    <DropdownMenuTrigger>
      <button type="button" class="icon-btn" :aria-label="name" :title="name">
        <span class="i-tabler-filter-2" text="[15px]" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="p-1">
      <RekaDropdownMenuItem
        v-for="choice in choices"
        :key="choice.value"
        :aria-label="itemName(choice)"
        :title="sortHint(sort, choice.value)"
        class="relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-3 text-[12.5px] input-ring focus:bg-muted"
        @select="press($event, choice.value)"
      >
        <span
          v-if="sortState(sort, choice.value) === 'ascending'"
          class="i-tabler-arrow-up absolute left-2 text-[13px]"
          aria-hidden="true"
        />
        <span
          v-else-if="sortState(sort, choice.value) === 'descending'"
          class="i-tabler-arrow-down absolute left-2 text-[13px]"
          aria-hidden="true"
        />
        {{ choice.label }}
      </RekaDropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
