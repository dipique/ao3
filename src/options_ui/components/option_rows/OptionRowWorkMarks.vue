<script setup lang="ts">
import { useId } from 'reka-ui'
import type { Ref } from 'vue'

import { countIds } from '#common'

// The nested toggle needs its own label id — OptionLabelId belongs to the
// collapsable row's own switch.
const hideReadId = useId()

const { enabled, hideRead, read, favorite } = useOption('workMarks') as unknown as {
  enabled: Ref<boolean>
  hideRead: Ref<boolean>
  read: Ref<string>
  favorite: Ref<string>
}

// The ids are stored delta-packed, so a count is a split — no need to unpack.
const readCount = computed(() => countIds(read.value))
const favoriteCount = computed(() => countIds(favorite.value))

/**
 * Rough size of the packed sets. Marks live in the synced options, which share a
 * 100 KB quota across every setting, so this is shown once the list is big enough
 * to be worth knowing about rather than hidden away as a surprise later.
 */
const packedKb = computed(() => (read.value.length + favorite.value.length) / 1024)
const showSize = computed(() => packedKb.value >= 1)

function clearRead() {
  // eslint-disable-next-line no-alert
  if (readCount.value && confirm(`Clear all ${readCount.value} read marks? This can't be undone (a daily backup may still have them).`))
    read.value = ''
}

function clearFavorites() {
  // eslint-disable-next-line no-alert
  if (favoriteCount.value && confirm(`Clear all ${favoriteCount.value} favorites? This can't be undone (a daily backup may still have them).`))
    favorite.value = ''
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Read &amp; favorite works"
    subtitle="Mark a work read or favorite from its right-click (or long-press) menu. Works are also marked read automatically whenever you press AO3's own “Mark as Read” button, so your read list fills itself in as you browse."
  >
    <div flex="~ col gap-3" mt-2>
      <!-- Grid, not flex: the switch has no text content, so as a flex item its
           min-width resolves to 0 and it gets squashed below its own width. A
           min-content column can't shrink it. Same shape OptionRow uses. -->
      <label :for="hideReadId" grid="~ cols-[1fr_min-content] items-center" gap-3 py-1 text="sm">
        <span flex="~ col gap-0.5">
          <span>Hide works you've marked as read</span>
          <span text="xs muted-fg">
            Collapses read works out of listings the same way your other filters do — so you stop re-adding
            something you already finished. An “Always show” rule on a work still wins over this.
          </span>
        </span>
        <Switch :id="hideReadId" v-model="hideRead" />
      </label>

      <div flex="~ col gap-2" text="sm" border-t pt-3>
        <div flex="~ items-center gap-3 justify-between">
          <span flex="~ col gap-0.5">
            <span>{{ readCount.toLocaleString() }} {{ readCount === 1 ? 'work' : 'works' }} marked read</span>
            <span text="xs muted-fg">Marks are stored with your settings, so they're included in backups and sync.</span>
          </span>
          <Button
            variant="outline"
            size="sm"
            :disabled="readCount === 0"
            @click="clearRead"
          >
            Clear all
          </Button>
        </div>

        <div flex="~ items-center gap-3 justify-between">
          <span>{{ favoriteCount.toLocaleString() }} {{ favoriteCount === 1 ? 'favorite' : 'favorites' }}</span>
          <Button
            variant="outline"
            size="sm"
            :disabled="favoriteCount === 0"
            @click="clearFavorites"
          >
            Clear all
          </Button>
        </div>

        <p v-if="showSize" text="xs muted-fg">
          These marks currently take about {{ packedKb.toFixed(1) }}&nbsp;KB of your settings (compressed further
          before syncing, which has a 100&nbsp;KB budget for all settings combined).
        </p>
      </div>
    </div>
  </OptionRowCollapsable>
</template>
