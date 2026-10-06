import type { BackupSummary } from '#common'

import { api, syncMeta, toast } from '#common'

/**
 * The backups this browser keeps, as the background lists them, and restoring
 * one. What the list says of them is {@link file://../model/backups.ts}.
 *
 * The list follows the backup index, which changes with every backup taken:
 * the first change of the day made on this page takes one, as does a restore.
 * The index is a `syncMeta` key whose changes `syncMeta`'s own listener skips,
 * so it is watched in storage directly.
 */

const INDEX_KEY = `${syncMeta.prefix}backups`

/** Null until the background has answered. */
const backups = ref<BackupSummary[] | null>(null)
/** The backup a restore is on its way for. */
const restoring = ref<string | null>(null)

/** Each read is numbered, so an answer that arrives after a later one's is dropped. */
let reads = 0

async function load(): Promise<void> {
  const read = ++reads
  let answer: BackupSummary[] | undefined
  try {
    answer = await api.listBackups.sendToBackground()
  }
  catch (error) {
    console.error(error)
  }
  if (read === reads)
    backups.value = answer ?? []
}

let started = false
function start(): void {
  if (started)
    return
  started = true
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && INDEX_KEY in changes)
      void load()
  })
  void load()
}

async function restore(key: string): Promise<void> {
  restoring.value = key
  try {
    await api.restoreBackup.sendToBackground(key)
    toast('Backup restored', { type: 'success' })
  }
  catch (error) {
    toast('Failed to restore backup; see console for details', { type: 'error' })
    console.error(error)
  }
  finally {
    restoring.value = null
  }
  await load()
}

export function useBackups() {
  start()
  return { backups, restoring, restore }
}
