<script setup lang="ts" generic="T extends string">
import type { AcceptableValue } from 'reka-ui'

/**
 * A list's sort, for its frame's header: a glyph button named for the sort the
 * list shows, opening a menu of the sorts it offers with that one checked.
 * Which order a sort puts the rows in is the list's own business; this only
 * holds the choice.
 */
const props = defineProps<{
  choices: readonly { value: T, label: string }[]
}>()

const sort = defineModel<T>({ required: true })

const name = computed(() => `Sort: ${props.choices.find(choice => choice.value === sort.value)?.label ?? ''}`)

function pick(value: AcceptableValue) {
  const choice = props.choices.find(choice => choice.value === value)
  if (choice)
    sort.value = choice.value
}
</script>

<template>
  <DropdownMenu :modal="false">
    <DropdownMenuTrigger>
      <button type="button" class="icon-btn" :aria-label="name" :title="name" data-action="sort" :data-sort="sort">
        <span class="i-tabler-filter-2" text="[15px]" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <RekaDropdownMenuRadioGroup :model-value="sort" class="p-1" @update:model-value="pick">
        <RekaDropdownMenuRadioItem
          v-for="choice in choices"
          :key="choice.value"
          :value="choice.value"
          :data-sort="choice.value"
          class="relative flex cursor-pointer select-none items-center rounded-[7px] py-1.5 pl-7 pr-3 text-[12.5px] input-ring data-[highlighted]:bg-[var(--row-hover)]"
        >
          <RekaDropdownMenuItemIndicator class="absolute left-2 grid place-items-center">
            <span class="i-tabler-check" text="[13px]" aria-hidden="true" />
          </RekaDropdownMenuItemIndicator>
          {{ choice.label }}
        </RekaDropdownMenuRadioItem>
      </RekaDropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
