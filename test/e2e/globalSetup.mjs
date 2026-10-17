import { ensureBuilt, findChrome, launch } from './helpers.mjs'

/**
 * What every e2e file needs, done once for the run (`--test-global-setup`):
 * the build, and one headless Chrome for all of them.
 *
 * `node --test` runs each file in a process of its own, and a Chrome per
 * process is what made the suite slow — not the launch, which is quick, but
 * the hundred-odd Chrome processes starving each other, until closing one took
 * seconds. So the Chrome is started here, and its address handed to the test
 * processes through the environment: {@link launch} connects to it and gives
 * each file a browser context of its own, which keeps the file's pages, cookies
 * and storage apart from every other file's. A file run on its own, with no
 * global setup, finds no address and launches a Chrome as it always did.
 *
 * The build is taken here too, so no file has to check for it or queue behind
 * another's.
 */

let browser

export async function globalSetup() {
  ensureBuilt()
  process.env.AO3E_E2E_BUILT = '1'
  const chromePath = findChrome()
  if (!chromePath)
    return
  browser = await launch(chromePath)
  process.env.AO3E_E2E_BROWSER = browser.wsEndpoint()
}

export async function globalTeardown() {
  await browser?.close()
}
