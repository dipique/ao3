export const MATCH_CASING_OFF = 'Off while Case sensitive is on'

/**
 * Why a text replacement's Match casing is inert, or null while it is live.
 * It capitalises the replacement of a match that ignored case, so under Case
 * sensitive it has nothing to do. Its own value is kept for when Case
 * sensitive goes off.
 */
export function matchCasingOff(rule: { caseSensitive?: boolean }): string | null {
  return rule.caseSensitive ? MATCH_CASING_OFF : null
}
