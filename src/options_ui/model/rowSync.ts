import type { Options } from '../../common/options.ts'

import { LOCAL_ONLY } from '../../common/syncCodec.ts'

/**
 * Whether a settings row's setting syncs: whether any of the options it edits
 * is one sync carries, unless the row is badged as working on this device
 * alone, which is what it does whatever it stores.
 */
export function rowSyncs(options: Iterable<keyof Options>, badges: readonly string[] = []): boolean {
  if (badges.includes('this-device'))
    return false
  for (const option of options) {
    if (!LOCAL_ONLY.has(option))
      return true
  }
  return false
}
