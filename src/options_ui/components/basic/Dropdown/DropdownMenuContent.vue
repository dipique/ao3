<script setup lang="ts">
import type { DropdownMenuContentEmits, DropdownMenuContentProps } from 'reka-ui'

const props = withDefaults(defineProps<DropdownMenuContentProps>(), {
  sideOffset: 4,
})
const emits = defineEmits<DropdownMenuContentEmits>()
const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <RekaDropdownMenuPortal>
    <RekaDropdownMenuContent
      v-bind="{ ...forwarded, ...$attrs }"
      class="animate-popover popover shadow-[var(--pop-shadow)]"
      border="1"
      z-99 min-w-32 rounded-[10px] p-[5px]
    >
      <slot />
    </RekaDropdownMenuContent>
  </RekaDropdownMenuPortal>
</template>
