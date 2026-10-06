<script setup lang="ts">
import type { options } from '#common'

const props = defineProps<{
  optionId: options.BooleanId
}>()

const optionValue = useOption(props.optionId)
const id = OptionLabelId.inject()
const off = OptionRowOff.inject(null)
</script>

<template>
  <Switch
    :id="id"
    v-model="optionValue"
    :disabled="!!off?.reason.value"
    :aria-describedby="off?.reason.value ? off.id : undefined"
  />
</template>
