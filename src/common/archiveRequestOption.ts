import { setImpersonateUserRequests } from './archiveRequest.ts'
import { options } from './options.ts'

/**
 * Keep this bundle's requests to AO3 in step with `impersonateUserRequests`:
 * the stored value now, and every change to it from then on, a key removed
 * (by a restore, say) reading as off. Resolves once the stored value is in
 * force, so a caller can hold its first request until then.
 */
export function followImpersonateUserRequests(): Promise<void> {
  options.addListener((changes) => {
    if ('impersonateUserRequests' in changes)
      setImpersonateUserRequests(changes.impersonateUserRequests === true)
  })
  return options.get('impersonateUserRequests').then(setImpersonateUserRequests)
}
