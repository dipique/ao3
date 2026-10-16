import type { RuleTiming } from '#common'

import { cache, summarizeRuleTimings } from '#common'

import { ruleTimingText } from '../model/ruleTiming.ts'

/**
 * What the foot of the options page says of how long the rules take to weigh,
 * kept in step with the stored record as AO3 tabs add to it.
 */
export function useRuleTimings() {
  const log = shallowRef<RuleTiming[]>([])

  const listener = (change: Partial<{ ruleTimings: RuleTiming[] }>) => {
    if (change.ruleTimings)
      log.value = change.ruleTimings
  }
  cache.addListener(listener)
  onScopeDispose(() => cache.removeListener(listener))
  void cache.get('ruleTimings').then((stored) => {
    log.value = stored
  })

  return computed(() => ruleTimingText(summarizeRuleTimings(log.value, Date.now())))
}
