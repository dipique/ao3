<script setup lang="ts">
import { sentence, withReason } from '../../model/phrases.ts'

/**
 * A whole number between two bounds, with a button either side that steps it
 * by one.
 *
 * Typing is free until the field is left or Enter is pressed; then the number
 * is clamped to the bounds and written. Typing "120" passes through "1", which
 * clamped on the spot would become the least the field takes and leave the
 * reader fighting it. An emptied field keeps the value it had. The arrow keys
 * step it as the buttons do, so the buttons stay out of the tab order.
 *
 * A button at its bound is off, and its tooltip says so. `off`, a reason
 * worded to follow a dash, turns the whole stepper off and says why.
 */
const props = defineProps<{
  min: number
  max: number
  /** The field's name, for one with no `<label>` of its own. */
  label?: string
  id?: string
  decrementLabel: string
  incrementLabel: string
  /**
   * `row`: at the height of a settings row's other controls (28 px), with
   * their 12.5 px text. Otherwise a dialog field's 30 px.
   */
  size?: 'default' | 'row'
  off?: string | null
}>()

const model = defineModel<number>({ required: true })

const reasonId = useId()

function take(value: number | undefined): void {
  if (value !== undefined)
    model.value = value
}

const decrementTitle = computed(() => withReason(props.decrementLabel, props.off || (model.value <= props.min ? `off at ${props.min}, the least it can be` : null)))
const incrementTitle = computed(() => withReason(props.incrementLabel, props.off || (model.value >= props.max ? `off at ${props.max}, the most it can be` : null)))
</script>

<template>
  <RekaNumberFieldRoot
    :model-value="model"
    :min="min"
    :max="max"
    :disabled="!!off"
    class="stepper"
    :class="{ 'stepper--row': size === 'row' }"
    @update:model-value="take"
  >
    <RekaNumberFieldDecrement class="stepper__button touch-target" :aria-label="decrementLabel" :title="decrementTitle" data-action="decrement">
      <span class="i-tabler-minus" aria-hidden="true" />
    </RekaNumberFieldDecrement>
    <RekaNumberFieldInput
      :id="id"
      class="stepper__value input-ring"
      :aria-label="label"
      :title="off ? withReason(label ?? '', off) : undefined"
      :aria-describedby="off ? reasonId : undefined"
    />
    <RekaNumberFieldIncrement class="stepper__button touch-target" :aria-label="incrementLabel" :title="incrementTitle" data-action="increment">
      <span class="i-tabler-plus" aria-hidden="true" />
    </RekaNumberFieldIncrement>
    <span v-if="off" :id="reasonId" hidden>{{ sentence(off) }}.</span>
  </RekaNumberFieldRoot>
</template>

<style scoped>
.stepper {
  display: inline-flex;
  align-items: center;
  height: 30px;
  border: 1px solid rgb(var(--color-input));
  border-radius: 7px;
  background-color: rgb(var(--color-default));
}
.stepper__button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  color: rgb(var(--color-muted-fg));
  font-size: 13px;
  cursor: pointer;
}
.stepper__button:hover:where(:enabled) {
  background-color: var(--row-hover);
  color: rgb(var(--color-default-fg));
}
.stepper__button:disabled {
  cursor: default;
  opacity: 0.48;
}
.stepper__value {
  width: 44px;
  height: 100%;
  border: none;
  border-right: 1px solid rgb(var(--color-hair));
  border-left: 1px solid rgb(var(--color-hair));
  background: transparent;
  color: rgb(var(--color-default-fg));
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.stepper__value:disabled {
  cursor: default;
}

.stepper--row {
  height: 28px;
}
.stepper--row .stepper__button {
  width: 26px;
  height: 26px;
}
.stepper--row .stepper__value {
  width: 52px;
  font-size: 12.5px;
}
</style>
