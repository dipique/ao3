<script setup lang="ts">
import { useId } from 'reka-ui'

const { enabled, show, applyToSearch } = useOption('hideLanguages')

const applyId = useId()

// AO3's dropdown takes one language, so this only has a meaning when exactly one
// is listed. Explained rather than hidden, so ticking nothing isn't a mystery.
const oneLanguage = computed(() => show.value.length === 1)
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Language"
    subtitle="Hide works based on their language"
  >
    <label for="hideWorks-languages" py-1 flex="~ row items-center gap-1">
      <span font="leading-none" text="sm muted-fg">Hide works that written in languages other than</span>
      <OptionLanguage />
    </label>

    <!-- Grid, not flex: the switch has no text content, so as a flex item its
         min-width resolves to 0 and it gets squashed. -->
    <label :for="applyId" grid="~ cols-[1fr_min-content] items-center" gap-3 py-1 text="sm">
      <span flex="~ col gap-0.5">
        <span>Also set AO3's own language filter</span>
        <span text="xs muted-fg">
          Pre-selects the language in the Sort &amp; Filter sidebar, so the archive filters by it
          server-side instead of loading works we then hide. You still press “Sort and Filter” as usual, and a
          language already chosen on the page is left alone.
          <template v-if="!oneLanguage">
            <br>
            Needs exactly one language above — AO3's dropdown only takes one.
          </template>
        </span>
      </span>
      <Switch :id="applyId" v-model="applyToSearch" :disabled="!oneLanguage" />
    </label>
  </OptionRowCollapsable>
</template>
