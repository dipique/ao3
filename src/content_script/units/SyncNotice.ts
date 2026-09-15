import { api, staleBackgroundMessage, SYNC_SCHEMA_VERSION, syncMeta, syncPauseMessage, toast } from '#common'
import { Unit } from '#content_script/Unit.js'

/** How long a notice stays up. Long enough to read; it's shown once per tab. */
const NOTICE_TIMEOUT_MS = 20_000

/**
 * Say so on AO3 pages when sync has stopped on this browser for a reason the
 * reader has to act on: an update held back for deleting most of a list, a
 * newer sync version the extension needs updating for, or a background running
 * an out-of-date build. The options page says the same, but a held update
 * usually arrives in the browser the reader *isn't* looking at, and they'd
 * otherwise only find out by opening its options.
 *
 * Waiting for an up-to-date browser (`older-cloud`) isn't mentioned: there's
 * nothing to do about it here.
 *
 * Once per tab session for each distinct pause, since units re-run on every
 * options change and navigation.
 */
export class SyncNotice extends Unit {
  static override get name() { return 'SyncNotice' }
  override get enabled() { return true }

  override async ready(): Promise<void> {
    const { enabled, pause, staleBuild } = await syncMeta.get(['enabled', 'pause', 'staleBuild'])

    let key: string
    let message: string
    if (staleBuild) {
      key = `stale:${staleBuild.onDisk}`
      message = staleBackgroundMessage(true)
    }
    else if (enabled && pause?.reason === 'held') {
      key = `held:${pause.g}:${pause.w}`
      message = syncPauseMessage(pause, SYNC_SCHEMA_VERSION)
    }
    else if (enabled && pause?.reason === 'newer-version') {
      key = `newer:${pause.remoteVersion}`
      message = syncPauseMessage(pause, SYNC_SCHEMA_VERSION)
    }
    else {
      return
    }

    const seen = `ao3e-sync-notice:${key}`
    try {
      if (sessionStorage.getItem(seen))
        return
      sessionStorage.setItem(seen, '1')
    }
    catch {
      // Storage refused (a sandboxed frame): show it anyway.
    }

    toast(message, {
      type: 'error',
      timeout: NOTICE_TIMEOUT_MS,
      action: {
        label: 'Open AO3 Enhancements options',
        onClick: () => void api.openOptionsPage.sendToBackground(),
      },
    })
    this.logger.warn('Sync notice shown:', key)
  }
}
