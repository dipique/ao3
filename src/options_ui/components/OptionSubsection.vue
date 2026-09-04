<script setup lang="ts">
const props = defineProps<{
  title: string
  subtitle?: string
}>()

OptionSubsectionName.provide(props.title)

const category = OptionCategoryName.inject(null)
const { open } = useCollapsibleSubsection(category, props.title)
const { showDescriptions, searching, subsectionMatches, highlight } = useOptionSearch()

const visible = computed(() => subsectionMatches(category, props.title))
</script>

<template>
  <section v-show="visible" :class="showDescriptions ? 'pt-5' : 'pt-3'">
    <RekaCollapsibleRoot v-model:open="open">
      <!-- Heading wraps the trigger, not the other way round: a button's children
           are presentational to screen readers, so a heading inside one is lost. -->
      <h2>
        <RekaCollapsibleTrigger
          class="input-ring"
          flex="~ row items-center gap-2" w-full cursor-pointer text-left
        >
          <span flex="~ col grow-1">
            <!-- v-html is safe here: `highlight` escapes the text and only ever adds <mark>. -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span
              block text="sm muted-fg" font="sans 600" tracking-wide uppercase
              v-html="highlight(props.title)"
            />
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span
              v-if="props.subtitle && (showDescriptions || searching)"
              text="sm muted-fg" max-w="sm:80%" block pt-1 tracking-normal normal-case
              v-html="highlight(props.subtitle)"
            />
          </span>
          <span text="lg muted-fg" shrink-0>
            <Icon v-if="open" i-mdi-chevron-up :label="`Collapse ${props.title}`" />
            <Icon v-else i-mdi-chevron-down :label="`Expand ${props.title}`" />
          </span>
        </RekaCollapsibleTrigger>
      </h2>
      <div border="b-1" mt-2 op-70 />
      <RekaCollapsibleContent animate-collapsible overflow-y-hidden>
        <slot />
      </RekaCollapsibleContent>
    </RekaCollapsibleRoot>
  </section>
</template>
