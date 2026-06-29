<script setup lang="ts">
const { state, setEnabled, setBackupsEnabled, setBackupCount } = useSync()

const backupCountModel = computed({
  get: () => state.backupCount,
  set: v => setBackupCount(Number(v)),
})

function formatLastSync(ts: number) {
  return ts ? new Date(ts).toLocaleString() : 'never'
}
</script>

<template>
  <OptionCategory
    title="Sync & Backups"
    subtitle="Sync your settings across browsers, and keep local backups"
  >
    <template #icon>
      <Icon i-mdi-cloud-sync-outline />
    </template>

    <OptionRow
      title="Sync settings across devices"
      subtitle="Store your options in the browser's synced storage so they follow you to other browsers signed into the same account. Cache is never synced."
    >
      <template #default="{ id }">
        <Switch :id="id" :model-value="state.enabled" @update:model-value="setEnabled" />
      </template>
      <template #extra>
        <p v-if="state.lastError" text="sm" pt-1 :style="{ color: '#dc2626' }">
          {{ state.lastError }}
        </p>
        <SyncStorageUsage v-if="state.enabled" />
        <p v-if="state.enabled && !state.lastError" text="xs muted-fg" pt-1>
          Last synced: {{ formatLastSync(state.lastSyncAt) }}
        </p>
      </template>
    </OptionRow>

    <OptionRow
      title="Keep daily backups"
      subtitle="Save a local snapshot of your settings the first time you change them each day. Backups stay on this device only."
    >
      <template #default="{ id }">
        <Switch :id="id" :model-value="state.backupsEnabled" @update:model-value="setBackupsEnabled" />
      </template>
    </OptionRow>

    <OptionRow
      v-if="state.backupsEnabled"
      title="Number of backups to keep"
      subtitle="Older backups beyond this count are deleted automatically."
    >
      <template #default="{ id }">
        <NumberInput :id="id" v-model="backupCountModel" :min="1" :max="90" />
      </template>
    </OptionRow>

    <OptionRow
      title="Restore a backup"
      subtitle="Roll back to an earlier snapshot. Your current settings are backed up first."
    >
      <SyncBackupsDialog />
    </OptionRow>
  </OptionCategory>
</template>
