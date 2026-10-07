<script setup lang="ts">
/**
 * An on/off setting of one list row, drawn as a glyph: a quiet glyph at 60%
 * while off, a tinted chip while on. The shape changes as well as the colour,
 * so the state reads in greyscale too. A toggle button (`aria-pressed`), or
 * with `asSwitch` a switch (`aria-checked`), named by `label`, with `tip`, or
 * else the label, as its tooltip.
 *
 * Attributes go on the button, so a `disabled` toggle is inert and an
 * `aria-describedby` says why.
 */
defineOptions({ inheritAttrs: false })

defineProps<{
  label: string
  /** The glyph's icon class, such as `i-tabler-eye-off`. */
  icon: string
  tip?: string
  /** A state of the row's own, such as whether a list is tracked, rather than a setting of it. */
  asSwitch?: boolean
}>()

/** A flag stored without a value reads as off. */
const pressed = defineModel<boolean>({ default: false })

/**
 * The attributes given a value. While the tooltip is open it describes the
 * button with its content, and an `aria-describedby` left undefined would
 * take that description away.
 */
function given(attrs: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined))
}
</script>

<template>
  <Tooltip :content="tip ?? label">
    <button
      v-bind="given($attrs)"
      type="button"
      class="icon-toggle touch-target input-ring"
      :role="asSwitch ? 'switch' : undefined"
      :aria-label="label"
      :aria-pressed="asSwitch ? undefined : pressed"
      :aria-checked="asSwitch ? pressed : undefined"
      @click="pressed = !pressed"
    >
      <span :class="icon" aria-hidden="true" />
    </button>
  </Tooltip>
</template>

<style scoped>
.icon-toggle {
  display: grid;
  place-items: center;
  width: 26px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background-color: transparent;
  color: rgb(var(--color-muted-fg));
  font-size: 16px;
  opacity: 0.6;
  cursor: pointer;
}
.icon-toggle:hover:where(:enabled) {
  background-color: var(--row-hover);
  opacity: 1;
}
.icon-toggle[aria-pressed='true'],
.icon-toggle[aria-checked='true'] {
  border-color: rgb(var(--color-brand-fg) / 0.32);
  background-color: rgb(var(--color-brand-fg) / 0.1);
  color: rgb(var(--color-brand-fg));
  opacity: 1;
}
.icon-toggle:disabled {
  cursor: default;
  opacity: 0.48;
}
</style>
