<script setup lang="ts">
import { COMPLETION_LABELS } from '#common'

const { enabled, completion } = useOption('searchCompletion')
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Default completion status"
    subtitle="Pre-selects AO3’s Completion Status filter, so listings start with only complete works, or only works in progress."
  >
    <label py-1 flex="~ row items-center gap-1">
      <span font="leading-none" text="sm muted-fg">Default the completion filter to</span>
      <Select v-model="completion" h-8 w-52>
        <SelectItem value="complete">{{ COMPLETION_LABELS.complete }}</SelectItem>
        <SelectItem value="incomplete">{{ COMPLETION_LABELS.incomplete }}</SelectItem>
      </Select>
    </label>
  </OptionRowCollapsable>
</template>
