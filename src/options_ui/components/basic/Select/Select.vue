<script setup lang="ts" generic="T extends string | number | null">
import type { SelectRootEmits, SelectRootProps } from 'reka-ui'

const props = defineProps<SelectRootProps<T> & {
  id?: string
  /**
   * `row`: at the height of a settings row's other controls (28 px), with
   * their 12.5 px text, and at least 132 px wide. Otherwise the select's
   * height and width are the classes it is given.
   */
  size?: 'default' | 'row'
}>()
const emits = defineEmits<SelectRootEmits<T>>()
const delegatedProps = reactiveOmit(props, 'id', 'size')
const forward = useForwardPropsEmits(delegatedProps, emits)

const SIZES = {
  default: { trigger: 'rounded-md px-3 py-2 text-sm', icon: 'text-4' },
  row: { trigger: 'h-7 min-w-[132px] gap-1.5 rounded-[7px] px-2 text-[12.5px]', icon: 'text-[13px]' },
} as const
const size = computed(() => SIZES[props.size ?? 'default'])
</script>

<template>
  <RekaSelectRoot v-bind="forward">
    <RekaSelectTrigger
      :id="props.id"
      class="touch-target whitespace-nowrap default input-ring disabled:cursor-not-allowed placeholder:text-muted-fg disabled:op50"
      :class="size.trigger"
      flex="~ items-center justify-between"
      border="1 input"
      v-bind="$attrs"
    >
      <RekaSelectValue v-slot="{ modelValue, selectedLabel }">
        <span
          :class="{ 'text-muted-fg': !modelValue }"
        >{{ selectedLabel[0] }}</span>
      </RekaSelectValue>
      <RekaSelectIcon as-child>
        <Icon i-mdi-chevron-down op50 :class="size.icon" />
      </RekaSelectIcon>
    </RekaSelectTrigger>

    <RekaSelectPortal>
      <RekaSelectContent position="popper" relative z-50 max-h-96 min-w-32 overflow-hidden border rounded="[10px]" p="[5px]" class="popover shadow-[var(--pop-shadow)]">
        <RekaSelectScrollUpButton>
          <Icon i-mdi-chevron-up />
        </RekaSelectScrollUpButton>
        <RekaSelectViewport class="h-[--reka-select-trigger-height] min-w-[--reka-select-trigger-width] w-full">
          <slot />
        </RekaSelectViewport>
        <RekaSelectScrollDownButton>
          <Icon i-mdi-chevron-down />
        </RekaSelectScrollDownButton>
      </RekaSelectContent>
    </RekaSelectPortal>
  </RekaSelectRoot>
</template>
