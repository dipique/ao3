<script setup lang="ts">
/**
 * A word or two of fact set beside a name, such as "Needs login". `warn` marks
 * one worth noticing before switching the setting on.
 */
defineProps<{ warn?: boolean }>()
</script>

<template>
  <span
    :class="warn ? 'border-warning text-warning' : 'border-border text-muted-fg'"
    inline-block whitespace-nowrap border="1 solid" rounded px-1
    text="[9.5px]" font-700 leading="[14px]" tracking="[.06em]" uppercase
    style="vertical-align: 1px;"
  ><slot /></span>
</template>
