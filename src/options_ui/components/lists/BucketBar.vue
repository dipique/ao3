<script setup lang="ts">
import type { BucketBar } from '../../model/buckets.ts'

/**
 * A list's works as one bar: the cached ones in grey and the failed ones in
 * red against the whole list, the new ones the empty rest. The parts are only
 * colours, so the bar is named for every bucket, and its tooltip lists them.
 */
defineProps<{ bar: BucketBar }>()
</script>

<template>
  <span role="img" :aria-label="bar.label" :title="bar.tip" class="bucket-bar">
    <span v-if="bar.cached" class="bucket-bar__cached" :style="{ width: `${bar.cached}%` }" />
    <span v-if="bar.failed" class="bucket-bar__failed" :style="{ width: `${bar.failed}%` }" />
  </span>
</template>

<style scoped>
.bucket-bar {
  display: flex;
  width: 100%;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background-color: rgb(var(--color-input));
}
.bucket-bar > span {
  display: block;
  height: 100%;
}
.bucket-bar > span + span {
  margin-left: 1px;
}
.bucket-bar__cached {
  background-color: rgb(var(--color-muted-fg));
}
.bucket-bar__failed {
  background-color: rgb(var(--color-destructive));
}
</style>
