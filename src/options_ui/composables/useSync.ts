import { clamp } from '@antfu/utils'

import { api, syncMeta } from '#common'

/**
 * Options-page view of the device-local sync/backup settings ({@link syncMeta}).
 *
 * The `enabled` toggle is routed through the background (`api.setSyncEnabled`) so
 * the engine runs its enable/disable flow (seed, adopt, stop). The plain backup
 * settings are written straight to `syncMeta`. A storage listener keeps this
 * reactive state aligned with whatever the background writes back.
 */
const state = reactive({
  loaded: false,
  enabled: false,
  backupsEnabled: true,
  backupCount: 7,
  lastError: '',
  lastSyncAt: 0,
})

void syncMeta.get(['enabled', 'backupsEnabled', 'backupCount', 'lastError', 'lastSyncAt']).then((m) => {
  Object.assign(state, m, { loaded: true })
})

syncMeta.addListener((change) => {
  Object.assign(state, change)
})

export function useSync() {
  return {
    state,

    async setEnabled(value: boolean) {
      state.enabled = value // optimistic
      try {
        await api.setSyncEnabled.sendToBackground(value)
      }
      catch {
        state.enabled = !value // revert on failure
      }
    },

    setBackupsEnabled(value: boolean) {
      state.backupsEnabled = value
      void syncMeta.set({ backupsEnabled: value })
    },

    setBackupCount(value: number) {
      const count = clamp(Math.round(value) || 1, 1, 90)
      state.backupCount = count
      void syncMeta.set({ backupCount: count })
    },
  }
}
