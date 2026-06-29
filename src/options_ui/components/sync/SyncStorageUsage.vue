<script setup lang="ts">
import type { SyncUsage } from '#common'

import { api } from '#common'

const { state } = useSync()

const usage = ref<SyncUsage | null>(null)

async function refresh() {
  try {
    usage.value = await api.getSyncUsage.sendToBackground()
  }
  catch {
    usage.value = null
  }
}

onMounted(refresh)
// Re-read after each successful sync rather than polling (sync reads are quota'd).
watch(() => state.lastSyncAt, refresh)

// Per the request, the bar's maximum is the quota less our fixed format overhead.
const maxBytes = computed(() => Math.max(1, (usage.value?.quota ?? 0) - (usage.value?.overheadBytes ?? 0)))
const usedBytes = computed(() => Math.max(0, (usage.value?.used ?? 0) - (usage.value?.overheadBytes ?? 0)))
const pct = computed(() => Math.min(100, Math.round((usedBytes.value / maxBytes.value) * 100)))
const barColor = computed(() => (pct.value >= 90 ? '#dc2626' : pct.value >= 70 ? '#d97706' : '#16a34a'))

function kb(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KB`
}
</script>

<template>
  <div v-if="usage" flex="~ col gap-1" py-2>
    <div flex="~ row items-center justify-between" text="sm muted-fg">
      <span>Synced storage usage</span>
      <span>{{ kb(usedBytes) }} of {{ kb(maxBytes) }} ({{ pct }}%)</span>
    </div>
    <div h-3 w-full overflow-hidden rounded-full bg-input>
      <div h-full rounded-full transition-all :style="{ width: `${pct}%`, backgroundColor: barColor }" />
    </div>
    <span v-if="pct >= 90" text="xs" :style="{ color: barColor }">
      You're close to the sync storage limit. Reduce large filter lists or text replacements.
    </span>
  </div>
</template>
