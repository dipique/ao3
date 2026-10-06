<script setup lang="ts">
import type { options } from '#common'

import { dependentState } from '../model/masterGroup.ts'

/**
 * A master switch's row, and the rows it gates hanging from a bracket under it,
 * so the relationship is drawn rather than written into each description.
 *
 * Only rows the master really does silence belong in the slot: with it off they
 * are drawn inert and say why, which has to be what the extension does. Their
 * stored values are never touched, so switching the master back on finds them as
 * they were.
 */
const props = defineProps<{
  optionId: options.BooleanId
  title: string
  subtitle: string
}>()

const on = useOption(props.optionId)
const { searching } = useOptionSearch()

const state = OptionMasterState.provide(computed(() => dependentState({ title: props.title, on: on.value }, searching.value)))
</script>

<template>
  <div data-master-group>
    <OptionRow :title="title" :subtitle="subtitle" master>
      <OptionSwitch :option-id="optionId" />
    </OptionRow>
    <OptionDependents :off="state.inert">
      <slot />
    </OptionDependents>
  </div>
</template>
