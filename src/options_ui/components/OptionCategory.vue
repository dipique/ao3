<script setup lang="ts">
const props = defineProps<{
  title: string
  subtitle: string
}>()

const { id } = useAddNav(props.title)
const { open } = useCollapsibleCategory(props.title)
</script>

<template>
  <section :id="id" card px-2 sm:px-8 style="scroll-margin-top: calc(var(--header-height, 0));">
    <RekaCollapsibleRoot v-model:open="open">
      <!--
        The heading wraps the trigger rather than the other way round: a button's
        children are presentational to screen readers, so an <h1> nested inside
        one would drop out of the document outline the nav is built from.
      -->
      <h1>
        <RekaCollapsibleTrigger
          class="input-ring"
          flex="~ row" w-full cursor-pointer pb-2 pt-3 text-left
        >
          <span flex="~ col grow-1">
            <span block text="2xl primary" font="serif 500">
              {{ props.title }}
            </span>
            <span block font="sans light" max-w="sm:80%">
              {{ props.subtitle }}
            </span>
          </span>
          <span text="4xl op80" flex="~ row items-end" pl-6>
            <slot name="icon" />
          </span>
          <span text="2xl op60" flex="~ row items-end" pl-3>
            <Icon v-if="open" i-mdi-chevron-up :label="`Collapse ${props.title}`" />
            <Icon v-else i-mdi-chevron-down :label="`Expand ${props.title}`" />
          </span>
        </RekaCollapsibleTrigger>
      </h1>
      <div border="b-1" />
      <RekaCollapsibleContent animate-collapsible overflow-y-hidden>
        <slot />
      </RekaCollapsibleContent>
    </RekaCollapsibleRoot>
  </section>
</template>
