<script setup lang="ts">
import type { BackupSummary } from '#common'

import { api, toast } from '#common'

const open = ref(false)
const backups = ref<BackupSummary[]>([])
const loading = ref(false)
const restoringKey = ref<string | null>(null)

async function loadBackups() {
  loading.value = true
  try {
    backups.value = await api.listBackups.sendToBackground()
  }
  finally {
    loading.value = false
  }
}

watch(open, (isOpen) => {
  if (isOpen)
    void loadBackups()
})

async function restore(key: string) {
  restoringKey.value = key
  try {
    await api.restoreBackup.sendToBackground(key)
    toast('Backup restored', { type: 'success' })
    await loadBackups()
  }
  catch (e) {
    toast('Failed to restore backup; see console for details', { type: 'error' })
    console.error(e)
  }
  finally {
    restoringKey.value = null
  }
}

function formatWhen(ts: number) {
  return new Date(ts).toLocaleString()
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="outline">
        Manage backups
      </Button>
    </DialogTrigger>
    <DialogContent>
      <DialogTitle>
        Backups
      </DialogTitle>
      <DialogDescription class="sr-only">
        Choose a backup to restore. Your current settings are snapshotted first, so a restore can itself be undone.
      </DialogDescription>
      <div flex="~ col" max-h-96 overflow-y-auto pt-4>
        <p v-if="loading" text="sm muted-fg" py-2>
          Loading…
        </p>
        <p v-else-if="!backups.length" text="sm muted-fg" py-2>
          No backups yet. One is saved automatically the first time you change a setting each day.
        </p>
        <div
          v-for="b in backups"
          :key="b.key"
          flex="~ row items-center justify-between gap-3"
          border="b-1"
          py-3
        >
          <div flex="~ col">
            <span text="sm" font="500">{{ b.label }}</span>
            <span text="xs muted-fg">{{ formatWhen(b.createdAt) }}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            :disabled="restoringKey === b.key"
            @click="restore(b.key)"
          >
            {{ restoringKey === b.key ? 'Restoring…' : 'Restore' }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
