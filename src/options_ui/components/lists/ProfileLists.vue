<script setup lang="ts">
import type { SiteExportListRow } from '../../composables/useSiteExport.ts'
import type { ProfileCopy } from '../../model/profileLists.ts'

import { profileTiles } from '../../model/profileLists.ts'

/**
 * User profile lists: the reader's own Marked for Later and read works, as
 * two tiles side by side where there is room for both, and one over the other
 * where there isn't.
 */
const { profileRows, userId, view, loading } = useSiteExport()
const { lists } = useOption('trackedLists')
const { enabled: workMarks } = useOption('workMarks')
const now = useNow({ interval: 60_000 })

function copyOf(row: SiteExportListRow | null): ProfileCopy | null {
  return row && { key: row.key, count: row.count, scrapedAt: row.scrapedAt, buckets: row.buckets, unstored: row.unstored, listUrl: row.listUrl }
}

const tiles = computed(() => profileTiles({
  copies: { 'marked-for-later': copyOf(profileRows.value['marked-for-later']), 'read-works': copyOf(profileRows.value['read-works']) },
  userId: userId.value,
  settings: { trackedLists: { lists: lists.value }, workMarks: { enabled: workMarks.value } },
  job: view.value,
  now: now.value.getTime(),
}))
</script>

<template>
  <div class="tiles">
    <div class="tiles__grid">
      <ProfileListTile v-for="tile in tiles" :key="tile.id" :tile="tile" :row="profileRows[tile.id]" :loading="loading" />
    </div>
  </div>
</template>

<style scoped>
.tiles {
  container-type: inline-size;
  margin-top: 10px;
}
.tiles__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}
@container (min-width: 600px) {
  .tiles__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
}
</style>
