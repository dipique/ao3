<script setup lang="ts">
import type { RailBookmark } from '../../model/rail.ts'

import { holdForLink } from '../../composables/useSubsectionInView.ts'

const props = defineProps<{ bookmark: RailBookmark }>()

const hash = computed(() => `#${props.bookmark.id}`)
</script>

<template>
  <li>
    <a
      data-rail-item="bookmark"
      :href="hash"
      :title="bookmark.name"
      class="h-[26px] flex items-center gap-1.5 rounded-md px-2 text-xs text-muted-fg decoration-none input-ring hover:bg-default-fg/3 hover:text-default-fg"
      @click="holdForLink($event, hash)"
    >
      <span class="i-tabler-bookmark-filled shrink-0 text-[11px] text-brand-fg" aria-hidden="true" />
      <span data-rail-label min-w-0 truncate>{{ bookmark.name }}</span>
    </a>
  </li>
</template>
