/**
 * Put an explanation where the shell was, for anything that stops the exported
 * page before the app is up — so a reader is told the file could not be opened,
 * rather than shown a page that looks like an export which came out empty.
 *
 * Shared by the loader and the app's own entry point, which fail at different
 * stages and must say so the same way. Imports nothing, so it adds nothing to
 * either.
 */
export function fail(shell: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  shell.className = 'ao3e-site-inert'
  shell.replaceChildren()
  const p = document.createElement('p')
  p.append(document.createTextNode(`This page could not be opened — ${message}.`))
  shell.append(p)
  console.error('[AO3E] site export failed to start', error)
}
