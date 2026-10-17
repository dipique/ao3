/**
 * Whether a page's claim on shared work, made or last renewed at `at`, still
 * holds at `now`: a claim left unrenewed for `ttl` is a page that went away
 * mid-way, and holds nobody. `at` is 0 once the claim is withdrawn.
 *
 * Measured either way round, because `at` comes from another page's clock.
 */
export function claimLive(at: unknown, now: number, ttl: number): boolean {
  return typeof at === 'number' && at > 0 && Math.abs(now - at) < ttl
}
