<script setup lang="ts">
import { anchorSlug } from '../model/anchors.ts'

const props = defineProps<{
  title: string
  subtitle?: string
  /** Phrases of the subtitle to draw bold, each found after the last. */
  strong?: readonly string[]
}>()

OptionSubsectionName.provide(props.title)

const category = OptionCategoryName.inject(null)
useAddSubsection(props.title, category)
const { subsectionMatches, highlight, highlightStrong } = useOptionSearch()

const visible = computed(() => subsectionMatches(category, props.title))

/**
 * Anchor for a `#hash` jump. Sub-section headings are unique across the page, so
 * the slug of the title alone is enough — and short enough to write by hand.
 */
const id = anchorSlug(props.title)
registerAnchor({ id, kind: 'subsection', name: props.title, category, subsection: props.title })
</script>

<template>
  <section
    v-show="visible"
    :id="id"
    class="pt-[18px] md:pt-[22px]"
    style="scroll-margin-top: var(--shell-top);"
  >
    <div flex="~ items-baseline gap-3" mb-0.5>
      <!-- v-html is safe here: `highlight` escapes the text and only ever adds <mark>. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <h2
        class="text-[10.5px] md:text-[11px]"
        font="sans 700" leading="[15px]" tracking="[.085em]" whitespace-nowrap text-muted-fg uppercase
        v-html="highlight(props.title)"
      />
      <span h-px flex-1 bg-border aria-hidden="true" />
    </div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <p
      v-if="props.subtitle"
      class="[&_strong]:text-default-fg [&_strong]:font-600"
      text="[12px] muted-fg" max-w="[100ch]" mb-0.5 mt-1.5 leading-normal
      v-html="props.strong ? highlightStrong(props.subtitle, props.strong) : highlight(props.subtitle)"
    />
    <slot />
  </section>
</template>
