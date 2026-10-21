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
  /**
   * The widest the dialog grows: `sm` (32 rem) suits a short prompt, `md`
   * (600 px) a form, `lg` (64 rem) reading text. Sectioned dialogs default to
   * `md`, the rest to `sm`.
   */
  size?: 'sm' | 'md' | 'lg'
}>()
const emits = defineEmits<DialogContentEmits>()
const forwarded = useForwardPropsEmits(props, emits)
const forward = computed(() => {
  const { sections: _, size: __, ...rest } = forwarded.value
  return rest
})
const maxWidth = {
  sm: 'max-w-lg',
  md: 'max-w-[600px]',
  lg: 'max-w-5xl',
}
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
      :class="[
        maxWidth[size ?? (sections ? 'md' : 'sm')],
        sections ? 'max-h-[calc(100dvh-2rem)] [container-type:inline-size]' : 'p-6',
      ]"
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
