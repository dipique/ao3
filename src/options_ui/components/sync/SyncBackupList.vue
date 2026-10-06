<script setup lang="ts">
import type { BackupKind } from '#common'

import { backupList } from '../../model/backups.ts'

/**
 * The snapshots this browser keeps, listed in place: newest first, each with a
 * glyph for what took it, how long a backup of its kind is kept, when it was
 * taken, and Restore. What the list says is
 * {@link file://../../model/backups.ts}.
 *
 * Restoring replaces every setting, so Restore asks a second time in its own
 * place ({@link file://../../composables/useConfirmInPlace.ts}). The settings
 * it replaces are backed up first, so a restore can itself be undone.
 */
const { state } = useSync()
const { backups, restoring, restore } = useBackups()
const confirm = useConfirmInPlace()

const view = computed(() => backupList(backups.value, { enabled: state.backupsEnabled, count: state.backupCount }, Date.now()))

/** What took each kind: a day's first change, a restore, turning sync on, and a sync update held back or declined. */
const GLYPHS: Record<BackupKind, string> = {
  'daily': 'i-tabler-calendar',
  'pre-restore': 'i-tabler-arrow-back-up',
  'pre-sync': 'i-tabler-cloud-upload',
  'sync-held': 'i-mdi-pause-circle-outline',
  'sync-declined': 'i-tabler-cloud-x',
}

/**
 * Wide, a row is its glyph, its name over how long its kind is kept, the date,
 * and Restore. In a narrow frame the date goes under the name, in place of
 * the retention.
 */
const ROW = '"icon identity meta actions" / 20px minmax(0, 1fr) 230px 84px'
const NARROW_ROW = '"icon identity actions" "icon meta actions" / 20px minmax(0, 1fr) auto'

const restoreId = (key: string) => `backup-restore:${key}`

function press(key: string) {
  if (confirm.press(restoreId(key)))
    void restore(key)
}
</script>

<template>
  <ListFrame list-id="backups" title="Snapshots" :count="view.count" :empty="!!view.empty">
    <template #empty>
      <b v-if="view.empty?.title">{{ view.empty.title }}</b>
      {{ view.empty?.text }}
    </template>

    <ListRow
      v-for="row in view.rows"
      :key="row.key"
      :row-id="row.key"
      :template="ROW"
      :narrow-template="NARROW_ROW"
      class="backup-row"
    >
      <template #icon>
        <span :class="GLYPHS[row.kind]" text="[16px]" aria-hidden="true" />
      </template>
      <span class="backup-row__label">{{ row.label }}</span>
      <span class="backup-row__retention">{{ row.retention }}</span>
      <template #meta>
        <span tabular-nums>{{ row.when }}</span>
      </template>
      <template #actions>
        <!-- One button, armed or not, so a press from the keyboard keeps its focus. -->
        <button
          type="button"
          class="backup-row__restore"
          :class="confirm.armed(restoreId(row.key)) ? 'label-btn destructive border-destructive font-600' : 'outline-btn'"
          :aria-label="confirm.armed(restoreId(row.key)) ? `${row.restore}?` : row.restore"
          :disabled="restoring === row.key"
          @click="press(row.key)"
        >
          <template v-if="restoring === row.key">
            Restoring…
          </template>
          <template v-else-if="confirm.armed(restoreId(row.key))">
            Restore?
          </template>
          <template v-else>
            Restore
          </template>
        </button>
      </template>
    </ListRow>
  </ListFrame>
</template>

<style scoped>
/* Named by its hook as well, to outweigh the row's own 32 px whichever
   stylesheet comes first. */
.backup-row[data-list-row] {
  min-height: 40px;
}
.backup-row__label,
.backup-row__retention {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.backup-row__retention {
  color: rgb(var(--color-muted-fg));
  font-size: 11px;
  line-height: 14px;
}
.backup-row__restore {
  height: 26px;
  padding: 0 9px;
  font-size: 12px;
}

@container (max-width: 440px) {
  .backup-row__retention {
    display: none;
  }
}

/* A phone's rows and buttons are sized for a finger. */
@media (max-width: 767px) {
  .backup-row[data-list-row] {
    min-height: 52px;
  }
  .backup-row__restore {
    height: 34px;
  }
}
</style>
