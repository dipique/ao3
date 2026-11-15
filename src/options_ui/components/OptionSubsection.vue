<script setup lang="ts">
const props = defineProps<{
  /** Its key: its anchor id, and what its rows, the rail and links know it by ({@link file://../model/anchors.ts}). */
  anchor: string
  title: string
  subtitle?: string
  /** Phrases of the subtitle to draw bold, each found after the last. */
  strong?: readonly string[]
}>()

const id = useAnchorKey(props.anchor)
OptionSubsectionKey.provide(id)

const category = OptionCategoryKey.inject(null)
useAddSubsection({ category, id, title: props.title })
const { subsectionMatches, highlight, highlightStrong } = useOptionSearch()

const visible = computed(() => subsectionMatches(category, id))

registerAnchor({ id, kind: 'subsection', name: props.title, category, subsection: id })
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
