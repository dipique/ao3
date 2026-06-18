<script setup lang="ts">
import type { DialogDescriptionProps } from 'reka-ui'

const props = defineProps<DialogDescriptionProps>()
const forwardedProps = useForwardProps(props)
</script>

<template>
  <RekaDialogDescription v-bind="{ ...forwardedProps, ...$attrs }">
    <slot />
  </RekaDialogDescription>
</template>
