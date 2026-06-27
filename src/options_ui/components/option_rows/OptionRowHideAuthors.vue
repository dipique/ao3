<script setup lang="ts">
import { DEFAULT_AUTHOR_HIGHLIGHT_COLOR } from '#common'

const { enabled, defaultHighlightColor } = useOption('hideAuthors')

// Backed by an optional stored value; fall back to the built-in default for
// display so the colour control always has a concrete value to show.
const defaultColor = computed({
  get: () => defaultHighlightColor.value || DEFAULT_AUTHOR_HIGHLIGHT_COLOR,
  set: (v: string) => defaultHighlightColor.value = v,
})

OptionRowHideAuthorsContext.provide({
  editDialog: ref(null),
})
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Author"
    subtitle="Hide works written by certain authors/pseudonyms"
  >
    <OptionRowHideAuthorsTable />

    <label flex="~ items-center gap-3 justify-between" mt-3 text="sm">
      <span flex="~ col gap-0.5">
        <span>Default highlight color</span>
        <span text="xs muted-fg">Used by highlight filters, and force-shown (invert) authors, that don't set their own colour.</span>
      </span>
      <ColorInput v-model="defaultColor" />
    </label>

    <OptionRowHideAuthorsEditDialog />
  </OptionRowCollapsable>
</template>
