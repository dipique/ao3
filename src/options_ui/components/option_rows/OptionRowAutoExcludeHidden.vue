<script setup lang="ts">
import { MAX_PRIORITY, MIN_PRIORITY } from '#common'

const enabled = useOption('autoExcludeHidden')
const minPriority = useOption('autoExcludeMinPriority')
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    anchor="auto-exclude-hidden"
    :options="['autoExcludeHidden', 'autoExcludeMinPriority']"
    title="Exclude hidden works from the search"
    subtitle="When a rule hides a work outright, add what hid it to the search itself — ticked in AO3's own Sort &amp; Filter exclusions, or typed in when it isn't listed — so a page of twenty stops arriving with one work left on it. Nothing is submitted for you; press Sort and Filter when you're ready. Anything still carried by a work you always-show is left alone, and a rule below the minimum priority only hides its works."
  >
    <div py-1 flex="~ row wrap items-center gap-2.5" text="[12.5px] muted-fg" leading="[18px]">
      <label for="auto-exclude-min-priority">Only for rules of priority</label>
      <Stepper
        id="auto-exclude-min-priority"
        v-model="minPriority"
        :min="MIN_PRIORITY"
        :max="MAX_PRIORITY"
        size="row"
        decrement-label="Lower the minimum priority"
        increment-label="Raise the minimum priority"
      />
      <span>or higher</span>
    </div>
  </OptionRowCollapsable>
</template>
