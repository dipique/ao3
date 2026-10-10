import type { SetSyncResult } from './api.ts'
import type { AnswerRefusal } from './syncConsistency.ts'
import type { SyncPause } from './syncMeta.ts'

import { describePullLoss } from './syncGuard.ts'

/**
 * Said of what sync asks the reader when this browser's settings were backed
 * up as it asked. In the present tense: a backup that would repeat the newest
 * of its kind isn't written, and that one, taken earlier, holds them.
 */
export const HELD_BACKUP_NOTE = `This browser's settings are backed up.`

/**
 * Why an answer to what sync asks was refused: the synced settings can't be
 * read whole, and keeping this browser's settings backs them up first, while
 * using them applies them. Within the wait another browser is taken to be
 * still sending them; past it, they are inconsistent, and the sync panel
 * offers to replace them.
 */
export function answerRefusedMessage(refused: AnswerRefusal, choice: 'keep' | 'accept'): string {
  if (refused === 'sending')
    return 'Another browser is still sending its settings. Try again in a moment.'
  return choice === 'keep'
    ? 'Your synced settings are inconsistent, so they can\'t be backed up before they\'re replaced.'
    : 'Your synced settings are inconsistent, so they can\'t be used.'
}

/**
 * What the reader is told when sync stops, in one place: the options page and
 * the notice on AO3 pages say the same thing. `version` is the sync version of
 * the build doing the telling.
 */
export function syncPauseMessage(pause: SyncPause, version: number): string {
  switch (pause.reason) {
    case 'held': {
      const backup = pause.backedUp ? ` ${HELD_BACKUP_NOTE}` : ''
      return `Sync is on hold: an update from another browser would remove ${describePullLoss(pause.loss)}.${backup}`
    }
    case 'first-sync': {
      const backup = pause.backedUp ? ` ${HELD_BACKUP_NOTE}` : ''
      return `Sync is on hold: your synced settings differ from this browser's. Nothing changes until you choose which to keep.${backup}`
    }
    case 'newer-version':
      return `Sync is paused: ${versionPauseReason(pause, version)}`
    case 'older-cloud':
      return `Waiting for an up-to-date browser: ${versionPauseReason(pause, version)}`
  }
}

export type VersionPause = Extract<SyncPause, { reason: 'newer-version' | 'older-cloud' }>

/**
 * Why a version pause stopped sync, and what lifts it, as a clause for a lead
 * of the caller's own: both sync versions, and what the reader can do.
 */
export function versionPauseReason(pause: VersionPause, version: number): string {
  return pause.reason === 'newer-version'
    ? `your synced settings were saved by a newer version of AO3 Enhancements (sync version ${pause.remoteVersion}; this browser has ${version}). Update or reload the extension in this browser. Changes you make here won't sync until then.`
    : `your synced settings were saved by an older version of AO3 Enhancements (sync version ${pause.remoteVersion}; this browser has ${version}). They'll sync here once a browser running this version saves them.`
}

/**
 * The background isn't running the extension's current code. `confirmed` when
 * the background noticed itself (and has stopped syncing); otherwise it's the
 * options page that couldn't get a current answer from it.
 */
export function staleBackgroundMessage(confirmed: boolean): string {
  const effect = confirmed ? 'Sync is paused until then.' : 'Sync may not work until then.'
  return `This browser is running an out-of-date copy of the extension's background script. Reload AO3 Enhancements from your browser's extensions page. ${effect}`
}

export function syncRefusalMessage(result: Extract<SetSyncResult, { ok: false }>): string {
  return `Can't turn on sync: your synced settings need a newer version of AO3 Enhancements (sync version ${result.remoteVersion}; this browser has ${result.version}). Update or reload the extension first.`
}
