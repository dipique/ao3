<script setup lang="ts">
const text = useRuleTimings()
</script>

<template>
  <section flex="~ col gap-1" text="xs muted-fg" border="t-1" data-rule-timings mt-6 pt-3 leading-normal>
    <p>{{ text.summary }}</p>
    <p v-if="text.detail">
      {{ text.detail }}
    </p>
  </section>
</template>
