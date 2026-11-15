<script setup lang="ts">
const props = defineProps<{
  /** Its key: its anchor id, and what the rail, rows and links know it by ({@link file://../model/anchors.ts}). */
  anchor: string
  title: string
  subtitle: string
  /** Its icon on the rail, as an icon class such as `i-mdi-magnify`. */
  icon: string
  /** Its name on the rail, where the title is too long. */
  railLabel?: string
  /** Its name on the chip row of a narrow window, where the rail's name is too long. */
  chipLabel?: string
  /** It holds the lists the job runs on: the rail shows a running job on it, from any category. */
  jobs?: boolean
}>()

const id = useAnchorKey(props.anchor)
OptionCategoryKey.provide(id)

const railLabel = props.railLabel ?? props.title
useAddNav({ id, title: props.title, icon: props.icon, railLabel, chipLabel: props.chipLabel ?? railLabel, jobs: props.jobs })

// Also findable by a `#hash`, by its key or by the category's own name.
registerAnchor({ id, kind: 'category', name: props.title, category: id, subsection: null })

const { highlight } = useOptionSearch()
const { inPane } = useCurrentCategory()

const shown = computed(() => inPane(id))
</script>

<template>
  <!-- Hidden rather than unmounted while another category is shown, so every
       setting stays in the search index and every anchor can be jumped to. -->
  <section
    v-show="shown"
    :id="id"
    :data-category="id"
    pb-10
    style="scroll-margin-top: var(--shell-top);"
  >
    <div pb-4>
      <!-- v-html is safe here: `highlight` escapes the text and only ever adds <mark>. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <h1 class="text-[22px] md:text-[26px]" text-brand-fg font="serif 400" leading="[1.15]" v-html="highlight(props.title)" />
      <!-- eslint-disable-next-line vue/no-v-html -->
      <p class="text-[12.5px] md:text-[13px]" text-muted-fg leading-normal max-w="[62ch]" mt="[5px]" v-html="highlight(props.subtitle)" />
    </div>
    <slot />
  </section>
</template>
