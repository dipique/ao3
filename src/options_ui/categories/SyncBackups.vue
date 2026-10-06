<script setup lang="ts">
const { state, setBackupsEnabled, setBackupCount } = useSync()

const backupCountModel = computed({
  get: () => state.backupCount,
  set: v => setBackupCount(Number(v)),
})
</script>

<template>
  <OptionCategory
    title="Sync & Backups"
    subtitle="Carry your settings between browsers, and keep local snapshots you can roll back to."
    icon="i-mdi-cloud-sync-outline"
    rail-label="Sync &amp; backups"
    chip-label="Sync"
  >
    <OptionSubsection title="Sync">
      <SyncPanel />
    </OptionSubsection>

    <OptionSubsection
      title="Backups"
      subtitle="Snapshots of your settings, kept on this device only."
    >
      <OptionRow
        title="Keep daily backups"
        subtitle="Save a snapshot the first time you change a setting each day. Backups stay on this device."
      >
        <template #default="{ id }">
          <Switch :id="id" :model-value="state.backupsEnabled" @update:model-value="setBackupsEnabled" />
        </template>
      </OptionRow>

      <OptionDependents v-if="state.backupsEnabled">
        <OptionRow
          title="Number of daily backups to keep"
          subtitle="Older daily backups beyond this count are deleted automatically. Backups taken around turning on sync, a restore, or a sync update you held back are kept separately: the newest five of each."
        >
          <template #default="{ id }">
            <NumberInput :id="id" v-model="backupCountModel" :min="1" :max="90" />
          </template>
        </OptionRow>
      </OptionDependents>

      <OptionRow
        title="Restore a backup"
        subtitle="Roll back to an earlier snapshot. Your current settings are backed up first, so a restore can itself be undone."
      >
        <template #extra>
          <OptionRowInset>
            <SyncBackupList />
          </OptionRowInset>
        </template>
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
