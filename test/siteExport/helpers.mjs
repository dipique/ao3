import { build } from 'esbuild'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

import { findChrome, REPO_ROOT } from '../e2e/helpers.mjs'

/**
 * Shared rig for the site-export modules that need a DOM but not an extension.
 *
 * Unlike `test/e2e/`, nothing here builds the extension: one module is bundled
 * with esbuild and dropped into a blank page as a global, which costs a Chrome
 * launch and about a second. That's enough for the sanitizer and the text-
 * replacement bake, both of which are one pure-ish function over a document.
 */

export const chromePath = findChrome()
export const skipWithoutChrome = chromePath
  ? false
  : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/** Icons and inlined CSS, resolved to nothing — the real builder has plugins for both. */
const stubAssets = {
  name: 'stub-assets',
  setup(build) {
    build.onResolve({ filter: /^~icons\/|\?inline$/ }, args => ({ path: args.path, namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default ""', loader: 'js' }))
  },
}

/**
 * Bundle `entry` (a repo-relative path) and expose its exports as `globalName`
 * in a fresh blank page. Returns the page and a closer.
 *
 * `stubBrowser` installs the little of the extension API that `#common` touches
 * as it loads — the manifest read its logger banner does, and the
 * `storage.onChanged` reference `createStorage` holds. A module that imports the
 * barrel needs it; one that imports nothing does not.
 */
export async function loadModuleInPage(entry, globalName, { stubBrowser = false } = {}) {
  const built = await build({
    entryPoints: [join(REPO_ROOT, entry)],
    bundle: true,
    format: 'iife',
    globalName,
    write: false,
    logLevel: 'silent',
    // What the real builder's plugins and `DEFINE` provide. A module that
    // reaches `#common` pulls the whole barrel in with it — icons, an inlined
    // stylesheet and the build-time constants included — none of which has
    // anything to do with what these tests assert.
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.BROWSER': '"chrome"',
      'process.env.CONTEXT': '"page"',
    },
    plugins: [stubAssets],
  })
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true })
  const page = await browser.newPage()
  await page.goto('about:blank')
  if (stubBrowser)
    await page.evaluate(installBrowserStub)
  await page.evaluate(built.outputFiles[0].text)
  return { page, close: () => browser.close() }
}

/** Runs in the page. Enough `browser` for `#common` to finish importing. */
function installBrowserStub() {
  const event = { addListener() {}, removeListener() {}, hasListener: () => false }
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} }
  globalThis.browser = globalThis.chrome = {
    runtime: {
      id: 'test',
      getManifest: () => ({ short_name: 'AO3E', version: '0.0.0' }),
      getURL: path => path,
      onMessage: event,
      sendMessage: async () => undefined,
    },
    storage: { onChanged: event, local: area, sync: area, session: area, managed: area },
  }
}
