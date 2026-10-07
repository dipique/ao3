<script setup lang="ts">
import type { DropdownMenuItemEmits, DropdownMenuItemProps } from 'reka-ui'

const props = defineProps<DropdownMenuItemProps>()
const emits = defineEmits<DropdownMenuItemEmits>()
const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <RekaDropdownMenuItem
    v-bind="{ ...forwarded, ...$attrs }"
    class="input-ring"
    cursor="pointer data-[disabled]:default data-[disabled]:pointer-events-none"
    op="data-[disabled]:50"
    relative select-none rounded-[7px] text-sm transition-colors data-[highlighted]:bg-[var(--row-hover)]
  >
    <slot />
  </RekaDropdownMenuItem>
</template>
