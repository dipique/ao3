import type { SiteData } from '#content_script/siteExport/payload.js'

import { SITE_DATA_ID, SITE_SHELL_ID } from '#content_script/siteExport/payload.js'

import { fail } from './fail.ts'
import { installBrowserShim } from './shim.ts'

import './site.css'

/**
 * The exported page's app, as the loader (`loader.ts`) unpacks and runs it:
 * stand up a `browser`, then load the app.
 *
 * **The two-step is load-bearing.** `#common`'s storage layer captures
 * `browser.storage.onChanged` at module scope and its logger reads a setting the
 * moment it is imported, so the shim has to exist before any of that is
 * evaluated. A static import would be hoisted above the install; a dynamic one
 * runs when it is called, and the bundler keeps that deferral even with
 * everything inlined into a single file. Nothing here may import `#common`.
 *
 * Anything that goes wrong before the app is up leaves the reader with an
 * explanation in place of the shell, rather than a page that looks like an
 * export which came out empty.
 */
async function boot(): Promise<void> {
  const shell = document.getElementById(SITE_SHELL_ID)
  if (!shell)
    return

  try {
    const data = readData()
    const storage = await installBrowserShim({
      generatedAt: data.manifest.generatedAt,
      items: data.options.items,
    })

    const { startSite } = await import('./app.tsx')
    await startSite({ shell, data, storage })
  }
  catch (error) {
    fail(shell, error)
  }
}

function readData(): SiteData {
  const el = document.getElementById(SITE_DATA_ID)
  if (!el?.textContent)
    throw new Error('the list and works are missing from this file')
  return JSON.parse(el.textContent) as SiteData
}

void boot()
