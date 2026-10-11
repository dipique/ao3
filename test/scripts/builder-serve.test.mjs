import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * The options page as `serve` hands it out: its scripts come from the dev
 * server, while the page itself is the extension's, so a worker it starts has to
 * be a file in `dist/` at the page's own origin.
 */

process.env.BROWSER = 'firefox'
process.env.NODE_ENV = 'development'

const { createAsset } = await import('../../scripts/builder/Asset.ts')
const { createViteConfig } = await import('../../scripts/builder/vite.ts')
const { createServer } = await import('vite')

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SRC = join(ROOT, 'src')
const PAGE_URL = 'moz-extension://extension-id/options_ui/options_ui.html'
const RUNNER = '/src/options_ui/composables/useRegexRunner.ts'

let dist
let server

before(async () => {
  dist = mkdtempSync(join(tmpdir(), 'ao3e-serve-'))
  const opts = { command: 'serve', verbose: false, root: ROOT, src: SRC, dist, manifest: join(SRC, 'manifest.ts'), target: {} }
  await createAsset(opts.manifest, opts, 'manifest').init()
  const page = createAsset(join(SRC, 'options_ui/options_ui.html'), opts)
  await page.init()
  server = await createServer(await createViteConfig(page, page.inputs))
})

after(async () => {
  await server?.close()
  if (dist)
    rmSync(dist, { recursive: true, force: true })
})

/** Scheme and host: what `URL.origin` would be, had a `moz-extension:` URL one in Node. */
const site = url => `${url.protocol}//${url.host}`

/** Where the served module's `new Worker(…)` points, run as the page would run it. */
function workerUrl(code, moduleUrl) {
  const expression = code.match(/new\s+Worker\s*\(\s*(new\s+URL\s*\((?:[^()]|\([^()]*\))*\))/)?.[1]
  assert.ok(expression, 'the served module starts no worker')
  const runnable = expression.replaceAll('import.meta.url', JSON.stringify(moduleUrl))
  return vm.runInNewContext(runnable, { URL, location: { href: PAGE_URL } })
}

test('the regex worker the served page starts is a classic script in dist, at the page\'s origin', async () => {
  const { code } = await server.transformRequest(RUNNER)
  const url = workerUrl(code, `http://localhost:5173${RUNNER}`)

  assert.equal(site(url), site(new URL(PAGE_URL)))
  const file = join(dist, decodeURIComponent(url.pathname))
  assert.ok(existsSync(file), `${url.pathname} is not in dist`)
  assert.doesNotThrow(() => new vm.Script(readFileSync(file, 'utf8')), 'a classic worker can\'t import or export')
})
