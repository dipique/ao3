<script setup lang="ts">
import type { RadioGroupItemProps } from 'reka-ui'

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<Props>()
interface Props extends RadioGroupItemProps {
  value: string
  /** What choosing it does, as its tooltip. */
  label: string
}
const forwarded = useForwardProps(reactiveOmit(props, 'label'))
</script>

<!-- Drawn by the `RadioBox` it sits in. -->
<template>
  <Tooltip :content="label">
    <RekaRadioGroupItem
      v-bind="{ ...forwarded, ...$attrs }"
      :value="value"
      class="segment touch-target input-ring"
    >
      <slot />
    </RekaRadioGroupItem>
  </Tooltip>
</template>
