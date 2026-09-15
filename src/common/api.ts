import type { Tag } from './data.ts'
import type { toast } from './toast/toast.tsx'

import { isContextInvalidatedError, isExtensionContextValid } from './extensionContext.ts'

type Callback<Fn extends (...args: any) => Promise<any>> = (...args: Parameters<Fn>) => Promise<Awaited<ReturnType<Fn>> | void>

class APIMethod<Name extends string, Fn extends (...args: any) => Promise<any>> {
  #callbacks: Array<Callback<Fn>> = []
  #boundCallback: typeof APIMethod.prototype.callback
  private readonly name: Name

  constructor(name: Name) {
    this.name = name
    this.#boundCallback = this.callback.bind(this)
  }

  async sendToBackground(...args: Parameters<Fn>): Promise<Awaited<ReturnType<Fn>>> {
    // An orphaned content script has nothing to send to — see
    // {@link file://./extensionContext.ts}. Resolving undefined keeps a stale
    // tab quiet; every caller already copes with a message going unanswered.
    if (!isExtensionContextValid())
      return undefined as Awaited<ReturnType<Fn>>
    try {
      return await browser.runtime.sendMessage({ [this.name]: args })
    }
    catch (error) {
      if (!isContextInvalidatedError(error))
        throw error
      return undefined as Awaited<ReturnType<Fn>>
    }
  }

  async sendToTab(frame: { tabId: number, frameId: number }, ...args: Parameters<Fn>): Promise<Awaited<ReturnType<Fn>>>
  async sendToTab(tabId: number, ...args: Parameters<Fn>): Promise<Awaited<ReturnType<Fn>>>
  async sendToTab(tabIdOrFrame: number | { tabId: number, frameId: number }, ...args: Parameters<Fn>): Promise<Awaited<ReturnType<Fn>>> {
    const tabId = typeof tabIdOrFrame === 'number' ? tabIdOrFrame : tabIdOrFrame.tabId
    const frameId = typeof tabIdOrFrame === 'number' ? undefined : tabIdOrFrame.frameId

    return await browser.tabs.sendMessage(tabId, { [this.name]: args }, { frameId })
  }

  addListener(cb: Callback<Fn>): void {
    this.#callbacks.push(cb)
    this.attachCallback()
  }

  removeListener(cb: Callback<Fn>): void {
    this.#callbacks = this.#callbacks.filter(c => c !== cb)
    this.attachCallback()
  }

  hasListener(cb: Callback<Fn>): boolean {
    return this.#callbacks.includes(cb)
  }

  private attachCallback() {
    if (this.#callbacks.length && !browser.runtime.onMessage.hasListener(this.#boundCallback))
      browser.runtime.onMessage.addListener(this.#boundCallback)
    else if (!this.#callbacks.length && browser.runtime.onMessage.hasListener(this.#boundCallback))
      browser.runtime.onMessage.removeListener(this.#boundCallback)
  }

  private callback(msg: any, _sender: browser.runtime.MessageSender, sendResponse: (response?: any) => void): boolean {
    // Chrome doesn't support promise responses, refactor when https://issues.chromium.org/issues/40753031 is fixed
    void (async () => {
      if (msg && typeof msg === 'object' && this.name in msg) {
        const data = msg[this.name] as Parameters<Fn>
        for (const callback of this.#callbacks) {
          const result = await callback(...data)
          if (result) {
            sendResponse(result)
            return
          }
        }
      }
    })()
    return true
  }
}

function createAPI<const API extends { [k: string]: (...args: any) => Promise<any> }>() {
  return new Proxy({} as { [k: string]: APIMethod<string, any> }, {
    get(api, prop: string) {
      return api[prop] ??= new APIMethod<typeof prop, API[typeof prop]>(prop)
    },
  }) as {
    [K in keyof API]: K extends string ? APIMethod<K, API[K]> : never
  }
}

/**
 * What an AO3 tab made of a Marked for Later request it was asked to run.
 *
 * The archive's own list is changed by a request AO3 has to accept, and the
 * extension normally makes that request itself. Where it won't be accepted from
 * an extension origin, a page already *on* AO3 can make it instead — see
 * {@link file://./../content_script/markForLater.ts}. The answer comes back as a
 * value rather than as a rejection, because a message that crosses contexts
 * loses everything about an error except its text anyway, and the caller has to
 * tell "no tab heard this" from "a tab tried and AO3 said no".
 */
export type MarkDelegation = { ok: true } | { ok: false, error: string }

/** Lightweight backup descriptor for the options UI (no heavy options blob). */
export type BackupKind = 'daily' | 'pre-restore' | 'pre-sync' | 'sync-held' | 'sync-declined'
export interface BackupSummary {
  key: string
  createdAt: number
  date: string
  kind: BackupKind
  label: string
}

export interface SyncUsage {
  used: number
  quota: number
  overheadBytes: number
}

/**
 * What turning sync on did. Refused when the cloud copy was written at a higher
 * sync version than this build speaks: this build can't safely read it or write
 * over it. (Always an object, so the message always gets an answer.)
 */
export type SetSyncResult
  = | { ok: true }
    | { ok: false, reason: 'newer-version', remoteVersion: number, version: number }

export interface SyncStatus {
  enabled: boolean
  lastError: string
  lastSyncAt: number
  generation: number
  dirty: boolean
}

export const api = /* @__PURE__ */ createAPI<{
  getTag: (linkUrl: string) => Promise<Tag>
  toast: (...args: Parameters<typeof toast>) => Promise<void>
  openOptionsPage: () => Promise<void>
  runMigrations: () => Promise<void>

  /**
   * Take a work on or off Marked for Later from a tab that is already on AO3.
   * Sent to a tab, never to the background; `undefined` where nothing answered.
   */
  submitMark: (workId: string, save: boolean) => Promise<MarkDelegation | undefined>

  // Sync + backups (all handled in the background context).
  // Void-ish actions return `true` so the message channel always sends a response.
  setSyncEnabled: (enabled: boolean) => Promise<SetSyncResult>
  /** Answer a sync update held back by the deletion guard. Always answers (`resolved: false` when nothing was held). */
  resolveHeldSync: (choice: 'accept' | 'keep') => Promise<{ resolved: boolean }>
  clearSyncedData: () => Promise<boolean>
  getSyncUsage: () => Promise<SyncUsage>
  getSyncStatus: () => Promise<SyncStatus>
  listBackups: () => Promise<BackupSummary[]>
  restoreBackup: (key: string) => Promise<boolean>
}>()
