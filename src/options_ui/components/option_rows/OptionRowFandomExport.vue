<script setup lang="ts">
import type { FandomCache, ScrapedTagType } from '#common'

import { fandomCache, saveAs, toast } from '#common'

const counts = ref<Record<ScrapedTagType, number>>({ fandoms: 0, characters: 0, relationships: 0 })

const total = computed(() => counts.value.fandoms + counts.value.characters + counts.value.relationships)

async function refreshCounts(): Promise<void> {
  const all = await fandomCache.get()
  counts.value = {
    fandoms: Object.keys(all.fandoms).length,
    characters: Object.keys(all.characters).length,
    relationships: Object.keys(all.relationships).length,
  }
}

onMounted(refreshCounts)

async function startExport(): Promise<void> {
  const all = await fandomCache.get()
  const shape = (records: FandomCache[ScrapedTagType]) =>
    Object.values(records)
      .map(({ name, id }) => ({ name, id }))
      .sort((a, b) => a.name.localeCompare(b.name))

  const payload = {
    fandoms: shape(all.fandoms),
    characters: shape(all.characters),
    relationships: shape(all.relationships),
  }

  const now = new Date()
  const time = `${now.toISOString().slice(0, 10)}_${now.toISOString().slice(11, 19).replace(/:/g, '-')}`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  saveAs(blob, `AO3-Enhancements_fandom-ids_${time}.json`)
}

async function clearCache(): Promise<void> {
  await fandomCache.set({ fandoms: {}, characters: {}, relationships: {} })
  await refreshCounts()
  toast('Cleared learned fandom ids', { type: 'success' })
}
</script>

<template>
  <OptionRow
    title="Learned fandom ids"
    :subtitle="`${total} ids collected while browsing (${counts.fandoms} fandoms, ${counts.characters} characters, ${counts.relationships} relationships). Export to contribute them to the shared crossreference.`"
  >
    <div flex="~ row items-center gap-3">
      <Button variant="outline" :disabled="total === 0" @click.prevent="startExport">
        Export ids
      </Button>
      <Button variant="ghost" :disabled="total === 0" @click.prevent="clearCache">
        Clear
      </Button>
    </div>
  </OptionRow>
</template>
