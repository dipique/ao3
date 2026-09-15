import { clamp } from '@antfu/utils'

import type { SyncMeta, SyncPause } from '#common'

import { api, syncMeta, syncRefusalMessage, toast } from '#common'

/**
 * Options-page view of the device-local sync/backup settings ({@link syncMeta}).
 *
 * The `enabled` toggle is routed through the background (`api.setSyncEnabled`) so
 * the engine runs its enable/disable flow (seed, adopt, stop). The plain backup
 * settings are written straight to `syncMeta`. A storage listener keeps this
 * reactive state aligned with whatever the background writes back — including
 * a pause, which the reader answers through the background too.
 */
const state = reactive({
  loaded: false,
  enabled: false,
  backupsEnabled: true,
  backupCount: 7,
  lastError: '',
  lastSyncAt: 0,
  pause: null as SyncPause | null,
  /** An answer to a held update is on its way to the background. */
  resolving: false,
  /** Why turning sync on was just refused, until the switch is next touched. */
  refusal: '',
  /** The background noticed it isn't running the build on disk. */
  staleBuild: null as SyncMeta['staleBuild'],
  /** The background didn't answer as this page's own build (see {@link checkBackgroundBuild}). */
  backgroundOutdated: false,
})

void syncMeta.get(['enabled', 'backupsEnabled', 'backupCount', 'lastError', 'lastSyncAt', 'pause', 'staleBuild']).then((m) => {
  Object.assign(state, m, { loaded: true })
})

/** How long the background gets to say which build it is before it's presumed outdated. */
const BUILD_CHECK_TIMEOUT_MS = 5000

/**
 * Ask the background which build it's running. This page is always served
 * fresh from disk; the background may not be (Chrome can keep an unpacked
 * extension's old service worker running). A background from before this
 * question existed never answers at all, which is what the timeout is for; an
 * immediate empty answer means nothing is listening, which says nothing about
 * its build.
 */
async function checkBackgroundBuild(): Promise<void> {
  const timeout = new Promise<'timeout'>(resolve => setTimeout(resolve, BUILD_CHECK_TIMEOUT_MS, 'timeout'))
  try {
    const info = await Promise.race([api.getBuildInfo.sendToBackground(), timeout])
    state.backgroundOutdated = info === 'timeout' || (!!info && info.buildId !== process.env.BUILD_ID)
  }
  catch {
    // No background to ask.
  }
}
void checkBackgroundBuild()

syncMeta.addListener((change) => {
  Object.assign(state, change)
})

export function useSync() {
  return {
    state,

    async setEnabled(value: boolean) {
      state.enabled = value // optimistic
      state.refusal = ''
      try {
        const result = await api.setSyncEnabled.sendToBackground(value)
        // An older background answers `true`; only a refusal is an object with `ok: false`.
        if (result && typeof result === 'object' && !result.ok) {
          state.enabled = false
          state.refusal = syncRefusalMessage(result)
        }
      }
      catch {
        state.enabled = !value // revert on failure
      }
    },

    async resolveHeld(choice: 'accept' | 'keep') {
      state.resolving = true
      try {
        await api.resolveHeldSync.sendToBackground(choice)
      }
      catch (error) {
        toast('Could not answer the held sync update; see console for details', { type: 'error' })
        console.error(error)
      }
      finally {
        state.resolving = false
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
