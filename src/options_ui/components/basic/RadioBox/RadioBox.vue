<script setup lang="ts" generic="T extends string">
import type { RadioGroupRootProps } from 'reka-ui'

/**
 * One choice of a few, drawn as a segmented control: the choices
 * (`RadioBoxItem`) side by side in one frame, the chosen one tinted in the
 * brand colour.
 */
const props = defineProps<Omit<RadioGroupRootProps, 'modelValue'>>()
const forwarded = useForwardProps(props)

const modelValue = defineModel<T>({ required: true })
</script>

<template>
  <RekaRadioGroupRoot
    v-bind="{ ...forwarded, ...$attrs }"
    :model-value="modelValue"
    class="segmented"
    @update:model-value="(modelValue = $event as T)"
  >
    <slot />
  </RekaRadioGroupRoot>
</template>

<!-- The choices are styled from here: a tooltip wraps each, which leaves them without the item's own scope. -->
<style scoped>
.segmented {
  display: inline-flex;
  border: 1px solid rgb(var(--color-input));
  border-radius: 7px;
}
.segmented :deep(.segment) {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 11px;
  border: none;
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-muted-fg));
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
}
.segmented :deep(.segment:first-child) {
  border-radius: 6px 0 0 6px;
}
.segmented :deep(.segment:last-child) {
  border-radius: 0 6px 6px 0;
}
.segmented :deep(.segment + .segment) {
  border-left: 1px solid rgb(var(--color-input));
}
.segmented :deep(.segment:hover:not([aria-checked='true'])) {
  background-color: var(--row-hover);
  color: rgb(var(--color-default-fg));
}
.segmented :deep(.segment[aria-checked='true']) {
  background-color: rgb(var(--color-brand-fg) / 0.1);
  color: rgb(var(--color-brand-fg));
  font-weight: 600;
}
</style>
