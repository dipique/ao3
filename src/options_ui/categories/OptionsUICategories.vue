<script lang="ts" setup>
import type { ComponentPublicInstance } from 'vue'

import AboutMe from './AboutMe.vue'
import Advanced from './Advanced.vue'
import BlurbStats from './BlurbStats.vue'
import ChapterStats from './ChapterStats.vue'
import HideWorks from './HideWorks.vue'
import Search from './Search.vue'
import StyleTweaks from './StyleTweaks.vue'
import SyncBackups from './SyncBackups.vue'

const lastRef = ref<ComponentPublicInstance | null>(null)
const { height: lastHeight } = useElementSize(computed(() => lastRef.value?.$el), undefined, { box: 'border-box' })

const { anyOpen, anyCollapsed, collapseAll, expandAll } = useCategoryCollapse()
</script>

<template>
  <div
    flex="~ col gap2"
    px="2 md:4"
    :style="{ marginBottom: `calc(max(0px, 100vh - ${lastHeight}px - var(--header-height) - var(--footer-height)))` }"
  >
    <div flex="~ row items-center justify-end gap-2">
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
    <AboutMe />
    <BlurbStats />
    <ChapterStats />
    <HideWorks />
    <Search />
    <StyleTweaks />
    <SyncBackups />
    <Advanced ref="lastRef" />
  </div>
</template>
