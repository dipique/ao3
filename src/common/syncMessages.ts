import type { SetSyncResult } from './api.ts'
import type { SyncPause } from './syncMeta.ts'

import { describePullLoss } from './syncGuard.ts'

/**
 * What the reader is told when sync stops, in one place: the options page's sync
 * row and the notice on AO3 pages say the same thing. `version` is the sync
 * version of the build doing the telling.
 */
export function syncPauseMessage(pause: SyncPause, version: number): string {
  switch (pause.reason) {
    case 'held': {
      const backup = pause.backedUp ? ` A backup of this browser's settings was saved first.` : ''
      return `Sync is on hold: an update from another browser would remove ${describePullLoss(pause.loss)}.${backup}`
    }
    case 'newer-version':
      return `Sync is paused: your synced settings were saved by a newer version of AO3 Enhancements (sync version ${pause.remoteVersion}; this browser has ${version}). Update or reload the extension in this browser. Changes you make here won't sync until then.`
    case 'older-cloud':
      return `Waiting for an up-to-date browser: your synced settings were saved by an older version of AO3 Enhancements (sync version ${pause.remoteVersion}; this browser has ${version}). They'll sync here once a browser running this version saves them.`
  }
}

export function syncRefusalMessage(result: Extract<SetSyncResult, { ok: false }>): string {
  return `Can't turn on sync: your synced settings need a newer version of AO3 Enhancements (sync version ${result.remoteVersion}; this browser has ${result.version}). Update or reload the extension first.`
}
