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

const TONES = {
  destructive: 'border-destructive/40 bg-destructive/8',
  warning: 'border-warning/40 bg-warning/8',
  success: 'border-success/40 bg-success/8',
  neutral: 'border-muted-fg/40 bg-muted-fg/8',
} as const satisfies Record<Severity, string>
</script>

<template>
  <div
    :data-callout="severity"
    :class="TONES[severity]"
    grid="~ cols-[1rem_minmax(0,1fr)] gap-x-2.5"
    relative border="1 solid" rounded="[9px]" px-3 py-2.5 text="sm default-fg"
  >
    <SeverityGlyph :severity="severity" :glyph="glyph" mt-0.5 text-base />
    <div flex="~ col gap-2">
      <slot />
    </div>
  </div>
</template>
