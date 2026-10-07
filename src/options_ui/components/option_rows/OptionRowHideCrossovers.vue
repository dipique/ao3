<script setup lang="ts">
const { enabled, maxFandoms } = useOption('hideCrossovers')
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Crossovers"
    subtitle="Hide works listing more than a set number of fandoms — usually crossovers, anthologies or gift collections."
  >
    <div py-1 flex="~ row wrap items-center gap-2.5" text="[12.5px] muted-fg" leading="[18px]">
      <label for="hideWorks-crossovers">Hide when work has more than</label>
      <Stepper
        id="hideWorks-crossovers"
        v-model="maxFandoms"
        :min="1"
        :max="10"
        size="row"
        decrement-label="Fewer fandoms"
        increment-label="More fandoms"
      />
      <span>fandoms</span>
    </div>
  </OptionRowCollapsable>
</template>
