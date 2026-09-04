<script lang="ts" setup>
import type { ComponentPublicInstance } from 'vue'

import { vLayoutVar } from '../directives/vLayoutVar.ts'
import Advanced from './Advanced.vue'
import Reading from './Reading.vue'
import Search from './Search.vue'
import SiteFeatures from './SiteFeatures.vue'
import SyncBackups from './SyncBackups.vue'

const lastRef = ref<ComponentPublicInstance | null>(null)
const { height: lastHeight } = useElementSize(computed(() => lastRef.value?.$el), undefined, { box: 'border-box' })

const { anyOpen, anyCollapsed, collapseAll, expandAll } = useCategoryCollapse()
const { query, searching, showDescriptions, matchCount, total, clear } = useOptionSearch()

const searchInput = ref<ComponentPublicInstance | null>(null)
function focusSearch() {
  searchInput.value?.$el?.querySelector('input')?.focus()
}

// `/` jumps to the search from anywhere on the page; Escape leaves it again.
useEventListener(document, 'keydown', (event: KeyboardEvent) => {
  const inField = /^(?:input|textarea|select)$/i.test((event.target as HTMLElement | null)?.tagName ?? '')
  if (event.key === '/' && !inField && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    focusSearch()
  }
  else if (event.key === 'Escape' && inField && query.value) {
    clear()
  }
})
</script>

<template>
  <div
    flex="~ col gap2"
    px="2 md:4"
    :style="{ marginBottom: `calc(max(0px, 100vh - ${lastHeight}px - var(--header-height) - var(--footer-height)))` }"
  >
    <!--
      Sticky under the page header so search and the fold controls stay in reach
      once you have scrolled. `--toolbar-height` feeds the scroll-margin on every
      category and row, so a jumped-to anchor never lands underneath it.
    -->
    <div
      v-layout-var="{ height: '--toolbar-height' }"
      card pos="sticky z-40" :style="{ top: 'var(--header-height)' }" pb-2 pt-3
    >
      <div flex="~ row items-center gap-2 wrap">
        <div min-w-60 flex-1>
          <Input
            ref="searchInput"
            v-model="query"
            type="text"
            placeholder="Search settings…"
            aria-label="Search settings by name or description"
            autocomplete="off"
            spellcheck="false"
            text="sm" h-9 w-full py-1 pl-2
          >
            <button
              v-if="query"
              class="input-ring"
              text="4 muted-fg hover:default-fg"
              absolute inset-y-0 right-1 my-auto h-5 w-5 cursor-pointer rounded-md
              aria-label="Clear the settings search"
              @click="clear"
            >
              <Icon i-mdi-close-circle />
            </button>
          </Input>
        </div>
        <label flex="~ row items-center gap-2" ml-auto shrink-0 cursor-pointer text-sm>
          <Switch id="ao3e-show-descriptions" v-model="showDescriptions" />
          <span>Descriptions</span>
        </label>
        <Button
          variant="outline"
          size="sm"
          class="disabled:cursor-default disabled:op-50"
          :disabled="!anyOpen"
          @click="collapseAll"
        >
          <Icon i-mdi-unfold-less-horizontal mr-1 />
          Collapse all
        </Button>
        <Button
          variant="outline"
          size="sm"
          class="disabled:cursor-default disabled:op-50"
          :disabled="!anyCollapsed"
          @click="expandAll"
        >
          <Icon i-mdi-unfold-more-horizontal mr-1 />
          Expand all
        </Button>
      </div>
      <p v-if="searching" text="xs muted-fg" pt-2>
        {{ matchCount }} of {{ total }} settings match.
      </p>
    </div>

    <p v-if="searching && matchCount === 0" text="sm muted-fg" py-8 text-center>
      Nothing matches “{{ query }}”. Try a word from the setting's description.
    </p>

    <SiteFeatures />
    <Search />
    <Reading />
    <SyncBackups />
    <Advanced ref="lastRef" />
  </div>
</template>
