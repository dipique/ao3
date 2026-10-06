<script setup lang="ts">
import type { Severity } from '../../model/severity.ts'

/**
 * A severity's glyph, in the severity's colour, with a word of its own for
 * screen readers. It carries the colour so the words beside it can stay in the
 * body colour: destructive red is too faint to read as text on the light
 * ground.
 *
 * `glyph`, an icon class, draws a state that has a glyph of its own in place of
 * the severity's, keeping the severity's colour and word.
 */
defineProps<{ severity: Severity, glyph?: string }>()

const GLYPHS = {
  destructive: { word: 'Error:', icon: 'i-tabler-circle-x', colour: 'text-destructive' },
  warning: { word: 'Warning:', icon: 'i-tabler-alert-triangle', colour: 'text-warning' },
  success: { word: 'Success:', icon: 'i-tabler-circle-check', colour: 'text-success' },
  neutral: { word: 'Note:', icon: 'i-tabler-info-circle', colour: 'text-muted-fg' },
} as const satisfies Record<Severity, { word: string, icon: string, colour: string }>
</script>

<template>
  <Icon :class="[glyph ?? GLYPHS[severity].icon, GLYPHS[severity].colour]" :label="GLYPHS[severity].word" data-glyph />
</template>
