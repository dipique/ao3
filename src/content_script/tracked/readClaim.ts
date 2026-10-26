import { cache, CLAIM_RENEW_MS, claimHolder, readClaim } from '#common'

/**
 * The read claim's storage half: one reader of the tracked lists across the
 * browser ({@link file://../../common/trackedReads.ts}'s `ReadClaim`). Kept
 * apart from the reader itself, so whoever runs one — a review tab, the options
 * page — decides what to do when another page holds it.
 */

/** A claim this page holds. */
export interface HeldClaim {
  /** Aborted when another page has taken the claim over: stop reading. */
  lost: AbortSignal
  /** Withdraw the claim, if it is still this page's. */
  release: () => Promise<void>
}

/** Who holds the claim now, as page run `self` sees it. */
export async function readClaimHolder(self: string): Promise<'free' | 'self' | 'other'> {
  return claimHolder(await cache.get('trackedReadClaim'), self, Date.now())
}

/**
 * Take the read claim for page run `self`, and renew it until it is released.
 * Null when another page's claim is live, or when one written at the same
 * moment won: the claim is read back after it is written, and the later write
 * is the one that holds.
 */
export async function claimReads(self: string): Promise<HeldClaim | null> {
  if (await readClaimHolder(self) === 'other')
    return null
  await cache.set({ trackedReadClaim: readClaim(self, Date.now()) })
  if (await readClaimHolder(self) !== 'self')
    return null

  const lost = new AbortController()
  const renew = setInterval(() => {
    void (async () => {
      if (await readClaimHolder(self) === 'self')
        await cache.set({ trackedReadClaim: readClaim(self, Date.now()) })
      else
        lost.abort()
    })().catch(err => console.error('[tracked] could not renew the read claim', err))
  }, CLAIM_RENEW_MS)
  const listener = (change: { trackedReadClaim?: unknown }): void => {
    const claim = change.trackedReadClaim as { by?: unknown } | undefined
    if (claim && claim.by !== self)
      lost.abort()
  }
  cache.addListener(listener)
  lost.signal.addEventListener('abort', () => {
    clearInterval(renew)
    cache.removeListener(listener)
  })

  return {
    lost: lost.signal,
    release: async () => {
      clearInterval(renew)
      cache.removeListener(listener)
      try {
        const claim = await cache.get('trackedReadClaim')
        if (claim.by === self && claim.at > 0)
          await cache.set({ trackedReadClaim: { ...claim, at: 0 } })
      }
      catch (err) {
        console.error('[tracked] could not withdraw the read claim', err)
      }
    },
  }
}
