import type { RuleTimingSample } from '#common'

import { api, ruleTimingEntry } from '#common'

/**
 * Hand one pass of the rules to the background to keep. The background owns the
 * stored list, so passes recorded at once — by several tabs, or by the tracked
 * review weighing page after page — are appended one after another rather than
 * over each other.
 */
export function recordRuleTiming(sample: RuleTimingSample): void {
  const entry = ruleTimingEntry(sample)
  if (entry)
    void api.recordRuleTiming.sendToBackground(entry).catch(error => console.error('[ruleTiming] not recorded', error))
}
