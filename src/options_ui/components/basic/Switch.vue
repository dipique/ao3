<script setup lang="ts">
import type { SwitchRootEmits, SwitchRootProps } from 'reka-ui'

/**
 * On or off: 34 × 20 px, a master switch's 40 × 22 (`OptionRow` sizes it),
 * and below 768 px, where it is touched, 40 × 24.
 */
const props = defineProps<SwitchRootProps>()
const emits = defineEmits<SwitchRootEmits>()
const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <RekaSwitchRoot
    v-bind="{ ...forwarded, ...$attrs }"
    class="switch touch-target input-ring"
  >
    <RekaSwitchThumb class="switch__thumb" />
  </RekaSwitchRoot>
</template>

<style scoped>
.switch {
  --switch-width: 34px;
  --switch-height: 20px;
  --thumb: 14px;
  display: inline-flex;
  flex: none;
  align-items: center;
  width: var(--switch-width);
  height: var(--switch-height);
  padding: 0;
  border: 1px solid rgb(var(--color-border));
  border-radius: 999px;
  background-color: rgb(var(--color-secondary));
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease;
}
.switch[aria-checked='true'] {
  border-color: rgb(var(--color-primary));
  background-color: rgb(var(--color-primary));
}
.switch:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.switch__thumb {
  display: block;
  width: var(--thumb);
  height: var(--thumb);
  margin-left: 2px;
  border-radius: 999px;
  background-color: rgb(var(--color-default));
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.28);
  pointer-events: none;
  transition: transform 0.12s ease;
}
.switch[aria-checked='true'] .switch__thumb {
  background-color: rgb(var(--color-primary-fg));
  transform: translateX(calc(var(--switch-width) - var(--thumb) - 6px));
}
@media (max-width: 767.98px) {
  .switch {
    --switch-width: 40px;
    --switch-height: 24px;
    --thumb: 18px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch__thumb {
    transition: none;
  }
}
</style>
