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
    <label py-1 flex="~ row wrap items-center gap-2.5" text="[12.5px] muted-fg" leading="[18px]">
      <span>Default the completion filter to</span>
      <Select v-model="completion" size="row" text-default-fg>
        <SelectItem value="complete">{{ COMPLETION_LABELS.complete }}</SelectItem>
        <SelectItem value="incomplete">{{ COMPLETION_LABELS.incomplete }}</SelectItem>
      </Select>
    </label>
  </OptionRowCollapsable>
</template>
