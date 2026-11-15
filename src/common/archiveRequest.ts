/**
 * Every request the extension makes of AO3 goes out through {@link archiveFetch},
 * so the *Impersonate user requests* option (`impersonateUserRequests`) has one
 * place to act. On, a request carries {@link USER_REQUEST_HEADERS}: what the
 * browser itself sends when the reader loads a page, and a script's request
 * otherwise lacks.
 *
 * The switch is module state rather than an argument because the callers are
 * spread across both bundles that talk to AO3, few of them hold the options,
 * and the paced fetch ({@link file://../content_script/archiveFetch.ts}) has to
 * stay importable under a plain `node --test`. Each bundle sets it from the
 * option as it starts and again whenever the option changes
 * ({@link file://./archiveRequestOption.ts}). Imports nothing, for the same
 * reason.
 */

/** What a page load sends that a script's request does not. */
export const USER_REQUEST_HEADERS: Readonly<Record<string, string>> = { 'Upgrade-Insecure-Requests': '1' }

let impersonating = false

export function setImpersonateUserRequests(on: boolean): void {
  impersonating = on
}

/** `init` as it should go out to AO3: itself while impersonating is off, and with {@link USER_REQUEST_HEADERS} added while it is on. */
export function archiveRequestInit(init: RequestInit = {}): RequestInit {
  if (!impersonating)
    return init
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(USER_REQUEST_HEADERS))
    headers.set(name, value)
  return { ...init, headers }
}

/** `fetch`, for a request to AO3. */
export function archiveFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, archiveRequestInit(init))
}
