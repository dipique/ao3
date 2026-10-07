<script setup lang="ts">
import { CROSSOVER_LABELS } from '#common'

const { enabled, crossovers } = useOption('searchCrossovers')
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Default crossovers"
    subtitle="Pre-selects AO3’s Crossovers filter, so listings start without crossovers, or with nothing else. AO3 decides what counts as one; hiding works by how many fandoms they list is under Customize search results."
  >
    <label py-1 flex="~ row wrap items-center gap-2.5" text="[12.5px] muted-fg" leading="[18px]">
      <span>Default the crossover filter to</span>
      <Select v-model="crossovers" size="row" text-default-fg>
        <SelectItem value="exclude">{{ CROSSOVER_LABELS.exclude }}</SelectItem>
        <SelectItem value="only">{{ CROSSOVER_LABELS.only }}</SelectItem>
      </Select>
    </label>
  </OptionRowCollapsable>
</template>
