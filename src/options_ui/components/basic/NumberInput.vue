<script setup lang="ts">
defineOptions({
  inheritAttrs: false,
})

defineProps<{
  unit?: string
}>()

const modelValue = defineModel<number>({ default: 0 })

const unitRef = ref<HTMLElement | null>(null)
const { width: unitWidth } = useElementSize(unitRef, undefined, { box: 'border-box' })

/**
 * The field hugs its value, so the width is the number's own length — but `ch`
 * is the advance of "0", which in a proportional font is narrower than the
 * digits actually drawn. Half a character of slack covers that, and a two
 * character floor keeps a single digit from landing in a box too small to hold
 * it (`Number of backups to keep`, the one field with no unit and so no right
 * padding to overflow into, clipped outright at 1ch).
 */
const modelWidth = computed(() => `${Math.max(2, String(modelValue.value).length) + 0.5}ch`)

/**
 * Right padding: the unit's own width, or a plain gutter when there is no unit,
 * so a right-aligned value never sits against the border.
 */
const rightPadding = computed(() => `${Math.max(unitWidth.value, 8)}px`)
</script>

<template>
  <div relative text-sm>
    <Input
      v-bind="$attrs"
      v-model="modelValue"
      type="number"
      :style="{
        '--unit-width': rightPadding,
        '--model-width': modelWidth,
      }"
      box-content h-8 pl-2 text-right
      pr="[var(--unit-width)]"
      w="[var(--model-width)]"
    >
      <template v-if="unit">
        <div
          ref="unitRef"
          pos="absolute inset-y-0 inset-r-0"
          flex="inline items-center"
          pointer-events-none pr-2
        >
          <div h-1lh>
            <span text="0.6rem" op50>
              {{ unit }}
            </span>
          </div>
        </div>
      </template>
    </Input>
  </div>
</template>
