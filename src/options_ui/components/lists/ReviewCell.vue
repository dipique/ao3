<script setup lang="ts">
/**
 * One cell of the Review block: a small capitalised head, what the cell holds,
 * and a line of help under it.
 *
 * `dim` greys a cell whose controls are off, as an inert settings row is
 * greyed; the controls inside are greyed once, with the cell, rather than
 * again by their own disabled look. `job` tints the cell the job is running
 * on.
 */
defineProps<{
  /** Its `data-review-cell`. */
  cell: string
  head: string
  dim?: boolean
  job?: boolean
}>()
</script>

<template>
  <div :data-review-cell="cell" class="review-cell" :class="{ 'review-cell--dim': dim, 'review-cell--job': job }">
    <div class="review-cell__head">
      {{ head }}
    </div>
    <slot />
    <p v-if="$slots.help" class="review-cell__help">
      <slot name="help" />
    </p>
  </div>
</template>

<style scoped>
.review-cell {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  padding: 12px 14px 13px;
}
.review-cell--job {
  background-color: rgb(var(--color-brand-fg) / 0.04);
}
.review-cell--dim {
  opacity: 0.48;
}
.review-cell--dim :deep(:disabled),
.review-cell--dim :deep(.stepper__button:disabled) {
  opacity: 1;
}

.review-cell__head {
  color: rgb(var(--color-muted-fg));
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  line-height: 15px;
  text-transform: uppercase;
}
.review-cell__help {
  margin: 0;
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
  line-height: 16px;
}
</style>
