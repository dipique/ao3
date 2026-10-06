<script setup lang="ts">
import { debounce } from '@antfu/utils'

import type { options } from '#common'

import type { OptionRowProps } from './OptionRow.vue'

const {
  title,
  subtitle,
  optionEnabledId,
  optionId,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  sliderMin,
  sliderMax,
  sliderStep = 1,
} = defineProps<OptionRowProps & {
  optionEnabledId?: options.BooleanId
  optionId: options.NumberId
  unit?: string
  min?: number
  max?: number
  sliderMin?: number
  sliderMax?: number
  sliderStep?: number
}>()

const optionEnabledValue = optionEnabledId ? useOption(optionEnabledId) : undefined
const optionValue = useOption(optionId)

const inputValue = ref(optionValue.value)

watch(optionValue, () => inputValue.value = optionValue.value)

const update = debounce(100, () => {
  optionValue.value = Math.min(Math.max(inputValue.value, min), max)
})

const sliderValue = computed({
  get: () => [Number(inputValue.value) || min],
  set: (v) => {
    // The slider is single-thumb, so there is always a v[0] — but it arrives as
    // an ordinary array, which reads as possibly-empty.
    inputValue.value = v[0] ?? min
    update()
  },
})

watch(optionValue, () => {
  if (optionEnabledValue)
    optionEnabledValue.value = optionValue.value > 0
})

/**
 * Where the row's title, description and control share a line, the slider
 * sits in the control cell before the number; narrower, the control has only
 * the number's room beside the text, so the slider takes the whole row, in an
 * inset under it. The width is the one at which `OptionRow` lays its parts out
 * side by side.
 */
const inControl = useMediaQuery('(min-width: 1024px)')

/** The slider, wherever it sits: a pointer's way to the number, which is the control a keyboard and a screen reader use. */
const slider = computed(() => ({
  'modelValue': sliderValue.value,
  'min': sliderMin ?? min,
  'max': sliderMax ?? max,
  'step': sliderStep,
  'aria-hidden': true,
  'onUpdate:modelValue': (v: number[] | undefined) => sliderValue.value = v!,
}))
</script>

<template>
  <OptionRow
    :title="title"
    :subtitle="subtitle"
  >
    <template #default="{ id }">
      <!--
        The control cell is inside the row's label, and a click on a label
        that lands on no control of its own focuses the one it labels: here
        the number, after every drag.
      -->
      <div v-if="inControl" w-30 shrink-0 @click.prevent>
        <Slider v-bind="slider" />
      </div>
      <NumberInput
        v-bind="$attrs"
        :id="id"
        v-model="inputValue"
        :unit="unit"
        @blur="update"
        @keydown="update"
      />
    </template>
    <template v-if="!inControl" #extra>
      <OptionRowInset>
        <Slider v-bind="slider" py-1.5 />
      </OptionRowInset>
    </template>
  </OptionRow>
</template>
