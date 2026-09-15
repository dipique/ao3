<script setup lang="ts">
import { SYNC_SCHEMA_VERSION, syncPauseMessage } from '#common'

const { state, setEnabled, setBackupsEnabled, setBackupCount, resolveHeld } = useSync()

const pauseMessage = computed(() => state.pause ? syncPauseMessage(state.pause, SYNC_SCHEMA_VERSION) : '')

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
    subtitle="Carry your settings between browsers, and keep local snapshots you can roll back to."
  >
    <template #icon>
      <Icon i-mdi-cloud-sync-outline />
    </template>

    <OptionRow
      title="Sync settings across devices"
      subtitle="Store your options in the browser's synced storage so they follow you to other browsers signed in to the same account. Cache is never synced."
    >
      <template #default="{ id }">
        <Switch :id="id" :model-value="state.enabled" @update:model-value="setEnabled" />
      </template>
      <template #extra>
        <p v-if="state.lastError" text="sm" pt-1 :style="{ color: '#dc2626' }">
          {{ state.lastError }}
        </p>
        <p v-if="state.refusal" role="alert" data-sync-refusal text="sm" pt-1 :style="{ color: '#dc2626' }">
          {{ state.refusal }}
        </p>
        <div v-if="pauseMessage" role="alert" :data-sync-pause="state.pause?.reason" flex="~ col gap-2" pt-2>
          <p text="sm" :style="{ color: '#d97706' }">
            {{ pauseMessage }}
          </p>
          <div v-if="state.pause?.reason === 'held'" flex="~ row wrap items-center gap-2">
            <Button size="sm" variant="outline" :disabled="state.resolving" data-sync-keep @click="resolveHeld('keep')">
              Keep this browser's settings
            </Button>
            <Button size="sm" :disabled="state.resolving" data-sync-accept @click="resolveHeld('accept')">
              Accept the update
            </Button>
          </div>
        </div>
        <SyncStorageUsage v-if="state.enabled" />
        <p v-if="state.enabled && !state.lastError" text="xs muted-fg" pt-1>
          Last synced: {{ formatLastSync(state.lastSyncAt) }}
        </p>
      </template>
    </OptionRow>

    <OptionRow
      title="Keep daily backups"
      subtitle="Save a snapshot the first time you change a setting each day. Backups stay on this device."
    >
      <template #default="{ id }">
        <Switch :id="id" :model-value="state.backupsEnabled" @update:model-value="setBackupsEnabled" />
      </template>
    </OptionRow>

    <OptionRow
      v-if="state.backupsEnabled"
      title="Number of daily backups to keep"
      subtitle="Older daily backups beyond this count are deleted automatically. Backups taken around turning on sync, a restore, or a sync update you held back are kept separately: the newest five of each."
    >
      <template #default="{ id }">
        <NumberInput :id="id" v-model="backupCountModel" :min="1" :max="90" />
      </template>
    </OptionRow>

    <OptionRow
      title="Restore a backup"
      subtitle="Roll back to an earlier snapshot. Your current settings are backed up first, so a restore can itself be undone."
    >
      <SyncBackupsDialog />
    </OptionRow>
  </OptionCategory>
</template>
