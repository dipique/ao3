<script setup lang="ts">
/**
 * Rows that depend on the switch in the row above, hanging from a bracket
 * under it, so the relationship is drawn rather than written into each
 * description. `off` dashes the bracket, for rows the switch has silenced.
 */
defineProps<{ off?: boolean }>()
</script>

<template>
  <div class="option-dependents" :data-off="off || undefined">
    <slot />
  </div>
</template>

<style>
/* The bracket is indented 32 px in all (margin, rule and padding), and the
   rows in it narrow their title column by as much, through `--row-title`. */
.option-dependents {
  --row-title: calc(264px - 32px);
  margin-left: 12px;
  padding-left: 18px;
  border-left: 2px solid rgb(var(--color-border));
}
.option-dependents[data-off] {
  border-left-style: dashed;
}
/* The bracket starts at the switch's row, so its first row needs no line above. */
.option-dependents > .option-row:first-child {
  border-top-width: 0;
}
</style>
