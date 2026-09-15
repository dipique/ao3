import { decompressEntry } from '#content_script/siteExport/compress.js'
import { SITE_APP_ID, SITE_SHELL_ID } from '#content_script/siteExport/payload.js'

import { fail } from './fail.ts'

/**
 * The one script an export carries uncompressed: it unpacks the app and runs it.
 *
 * The app travels the way the works do — a compressed entry in a data block
 * (`compress.ts`), deflated and checksummed — because it is the one part of the
 * file every export carries, and deflated it is about a third of the size. This
 * is what stands between that block and a running page, so it stays as small as
 * it can: the codec, the two element ids, and the failure message.
 *
 * The app goes in as an inline `<script>` rather than through `eval`, so it runs
 * in the page's global scope exactly as it would have written out in full, and
 * its errors are reported against a script like any other.
 */
async function load(): Promise<void> {
  const shell = document.getElementById(SITE_SHELL_ID)
  if (!shell)
    return

  try {
    // Checked here rather than in the app: without it there is no app to run.
    if (typeof DecompressionStream !== 'function')
      throw new TypeError('this browser is too old to unpack the works it holds')

    const packed = document.getElementById(SITE_APP_ID)?.textContent
    if (!packed)
      throw new Error('the app is missing from this file')

    const script = document.createElement('script')
    script.textContent = await decompressEntry(JSON.parse(packed))
    document.body.append(script)
  }
  catch (error) {
    fail(shell, error)
  }
}

void load()
