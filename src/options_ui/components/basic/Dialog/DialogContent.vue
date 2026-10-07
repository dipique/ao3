<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from 'reka-ui'

const props = defineProps<DialogContentProps & {
  /**
   * The content lays itself out in sections that bring their own padding,
   * such as a head, a body that scrolls and a foot. The dialog is up to
   * 600 px wide, never taller than the window, and a size container, so the
   * sections can follow its width.
   */
  sections?: boolean
}>()
const emits = defineEmits<DialogContentEmits>()
const forwarded = useForwardPropsEmits(props, emits)
const forward = computed(() => {
  const { sections: _, ...rest } = forwarded.value
  return rest
})
</script>

<template>
  <RekaDialogPortal>
    <RekaDialogOverlay
      pos="fixed inset-0 z-50"
      class="animate-overlay bg-[var(--scrim)]"
    />
    <RekaDialogContent
      v-bind="{ ...forward, ...$attrs }"
      pos="fixed left-1/2 top-1/2 z-50"
      translate="x--1/2 y--1/2"
      flex="~ col"
      rounded="sm:[12px]"
      w-full border
      class="animate-dialog popover shadow-[var(--dlg-shadow)]"
      :class="sections ? 'max-w-[600px] max-h-[calc(100dvh-2rem)] [container-type:inline-size]' : 'max-w-lg p-6'"
    >
      <slot />

      <RekaDialogClose
        class="input-ring"
        absolute right-4 top-4 rounded-sm
      >
        <Icon i-mdi-close label="Close" />
      </RekaDialogClose>
    </RekaDialogContent>
  </RekaDialogPortal>
</template>
