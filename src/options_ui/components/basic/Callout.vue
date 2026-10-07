<script setup lang="ts">
import type { Severity } from '../../model/severity.ts'

/**
 * A message with a severity. The severity's colour marks a glyph
 * (`SeverityGlyph`), the edge and a tint, and the words stay in the body
 * colour. `glyph` draws a state's own glyph in place of the severity's.
 *
 * Attributes fall through to the outer element, so a `role="alert"` or a test
 * hook goes on the callout itself.
 */
defineProps<{ severity: Severity, glyph?: string }>()

/** Each severity's colour, which the edge and the tint are mixed from. */
const TONES = {
  destructive: '--callout: var(--color-destructive)',
  warning: '--callout: var(--color-warning)',
  success: '--callout: var(--color-success)',
  neutral: '--callout: var(--color-muted-fg)',
} as const satisfies Record<Severity, string>
</script>

<template>
  <div
    :data-callout="severity"
    :style="TONES[severity]"
    class="callout"
    grid="~ cols-[1rem_minmax(0,1fr)] gap-x-2.5"
    relative px-3 py-2.5
  >
    <SeverityGlyph :severity="severity" :glyph="glyph" mt-px text-base />
    <div flex="~ col gap-2">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* The tint is mixed into the page's ground, so it reads the same on any ground the callout sits on. */
.callout {
  border: 1px solid color-mix(in srgb, rgb(var(--callout)) 42%, transparent);
  border-radius: 9px;
  background-color: color-mix(in srgb, rgb(var(--callout)) 8%, rgb(var(--color-default)));
  color: rgb(var(--color-default-fg));
  font-size: 12.5px;
  line-height: 18px;
}
</style>
