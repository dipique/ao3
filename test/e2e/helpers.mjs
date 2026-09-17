import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(here, '..', '..')
export const DIST = join(REPO_ROOT, 'dist', 'chrome')

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
}

/** Locate an installed Chrome/Chromium. Override with CHROME_PATH. */
export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return candidates.find(p => p && existsSync(p))
}

/**
 * What the build reads, relative to the repo root. A change to any of it makes
 * `dist/chrome` stale — the e2e tests drive the *built* bundle, so testing
 * against a stale one silently reports on code that is no longer there.
 */
const BUILD_INPUTS = ['src', 'scripts/builder', 'uno.config.ts', 'package.json']

/**
 * Touched after a successful build; its mtime is what staleness is measured
 * against. A stamp of our own rather than one of the build's outputs, because
 * the builder neither cleans `dist/` nor writes its files in a fixed order —
 * and because it generates into `src/` (the auto-import `.d.ts` files), so any
 * mark made *during* the build would already look older than its own inputs.
 *
 * Kept beside `dist/chrome` rather than inside it: `web-ext build` packages that
 * directory wholesale, and a stray file there would ship.
 */
const BUILD_STAMP = join(REPO_ROOT, 'dist', '.e2e-build-stamp')

/** Held while one process builds, so parallel test files queue instead of racing. */
const BUILD_LOCK = join(REPO_ROOT, 'dist', '.e2e-build-lock')

/** How long to wait for another process's build before giving up. */
const BUILD_TIMEOUT = 10 * 60 * 1000

/**
 * Newest mtime at or under `path`, or 0 if it isn't there. Directories count
 * too: deleting a file leaves no mtime of its own, but bumps its parent's.
 */
function newestMtime(path) {
  const stats = statSync(path, { throwIfNoEntry: false })
  if (!stats)
    return 0
  if (!stats.isDirectory())
    return stats.mtimeMs
  let newest = stats.mtimeMs
  for (const entry of readdirSync(path))
    newest = Math.max(newest, newestMtime(join(path, entry)))
  return newest
}

function isStale() {
  if (!existsSync(join(DIST, 'manifest.json')))
    return true
  const builtAt = statSync(BUILD_STAMP, { throwIfNoEntry: false })?.mtimeMs ?? 0
  return BUILD_INPUTS.some(input => newestMtime(join(REPO_ROOT, input)) > builtAt)
}

/**
 * A synchronous pause, matching `ensureBuilt`'s synchronous callers — they all
 * run before any test in the file does, so waiting here holds up nothing else.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function build() {
  const res = spawnSync(process.execPath, ['scripts/builder/build.ts', 'build'], {
    cwd: REPO_ROOT,
    env: { ...process.env, BROWSER: 'chrome', NODE_ENV: 'production' },
    stdio: 'inherit',
  })
  if (res.status !== 0)
    throw new Error('Failed to build dist/chrome for e2e test')
  writeFileSync(BUILD_STAMP, `${new Date().toISOString()}\n`)
}

/**
 * Build `dist/chrome` (production, cross-platform) if it's missing or older than
 * the sources it was built from.
 *
 * `node --test a.mjs b.mjs` runs each file in its own process, concurrently, and
 * every one of them calls this — so the build is taken under a lock and the
 * losers wait for it rather than all writing over each other's output.
 */
export function ensureBuilt() {
  const deadline = Date.now() + BUILD_TIMEOUT
  mkdirSync(dirname(BUILD_LOCK), { recursive: true })

  for (;;) {
    if (!isStale())
      return

    try {
      // Directory creation is atomic across processes: whoever doesn't get
      // EEXIST owns the build.
      mkdirSync(BUILD_LOCK)
    }
    catch (err) {
      if (err.code !== 'EEXIST')
        throw err
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for another test process to build dist/chrome. If no build is running, remove ${BUILD_LOCK}.`)
      sleepSync(200)
      continue
    }

    try {
      // Re-checked under the lock: the process we queued behind may have just
      // built exactly what we need.
      if (isStale())
        build()
    }
    finally {
      rmSync(BUILD_LOCK, { recursive: true, force: true })
    }
    return
  }
}

/** Serve one directory over HTTP. Returns { url, close }. */
export async function serveDir(root) {
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0])
    // Chrome asks for this whether or not the page mentions it, and a 404 for it
    // lands in the console as an error — which would be the only thing standing
    // between a test and "this page logged nothing".
    if (path === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    try {
      const file = join(root, path)
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
      res.end(body)
    }
    catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  return {
    url: `http://localhost:${port}`,
    // `close` alone waits for every keep-alive socket to time out, and Chrome
    // holds its idle ones for minutes — so the sockets go first.
    close: () => new Promise((r) => {
      server.closeAllConnections()
      server.close(r)
    }),
  }
}

/** Serve dist/chrome over HTTP. Returns { url, close }. */
export const serveDist = () => serveDir(DIST)

/**
 * Injected into the page before any extension script runs. Provides an in-memory
 * `browser`/`chrome` mock matching the subset of the API used by src/common/storage.ts,
 * and records every storage.local.set into window.__writes.
 *
 * `seed` is a JSON-serialisable object of initial prefixed storage entries.
 */
export function installMock(seed) {
  window.__writes = []
  const store = { ...seed }
  const listeners = new Set()
  const toArr = k => (k == null ? null : (Array.isArray(k) ? k : (typeof k === 'object' ? Object.keys(k) : [k])))
  const area = name => ({
    get: keys => Promise.resolve((() => {
      const out = {}
      const ks = toArr(keys) ?? Object.keys(store)
      for (const k of ks) {
        if (k in store)
          out[k] = store[k]
      }
      if (keys && !Array.isArray(keys) && typeof keys === 'object') {
        for (const k of Object.keys(keys)) {
          if (!(k in out))
            out[k] = keys[k]
        }
      }
      return out
    })()),
    set: (items) => {
      Object.assign(store, items)
      window.__writes.push(JSON.parse(JSON.stringify(items)))
      const changes = {}
      for (const [k, v] of Object.entries(items)) changes[k] = { newValue: v }
      listeners.forEach(l => l(changes, name))
      return Promise.resolve()
    },
    remove: (keys) => {
      for (const k of toArr(keys) || [])
        delete store[k]
      return Promise.resolve()
    },
    clear: () => {
      for (const k of Object.keys(store))
        delete store[k]
      return Promise.resolve()
    },
  })
  const onChanged = { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l), hasListener: l => listeners.has(l) }
  const storage = { local: area('local'), sync: area('sync'), session: area('session'), managed: area('managed'), onChanged }
  const noop = () => {}
  const deep = () => new Proxy(noop, { get: (_t, p) => (p === 'then' ? undefined : deep()), apply: () => undefined })
  // `api.ts` guards every (de)registration with hasListener, so the event shape
  // has to be complete or the content script throws on its first addListener.
  const msgListeners = new Set()
  const onMessage = {
    addListener: l => msgListeners.add(l),
    removeListener: l => msgListeners.delete(l),
    hasListener: l => msgListeners.has(l),
  }
  const base = {
    storage,
    runtime: { id: 'mock', getURL: p => p, sendMessage: () => Promise.resolve(), connect: () => ({ onMessage: { addListener: noop }, postMessage: noop, onDisconnect: { addListener: noop } }), onMessage, getManifest: () => ({ version: '0.0.0', short_name: 'AO3E' }) },
    i18n: { getMessage: () => '' },
  }
  const chrome = new Proxy(base, { get: (t, p) => (p in t ? t[p] : deep()) })
  window.chrome = chrome
  window.browser = chrome
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Storage items for stored search-view lists, in the layout the extension keeps
 * them in: each list's work ids under `cache.searchLists`, and each work's blurb
 * once, under `blurb.<short id>`.
 *
 * Takes lists in the shape a list used to be stored in — `{ [key]: { scrapedAt,
 * blurbsHtml, descriptor? } }` — because a fixture says best what a list holds
 * by its markup. The blurbs go in unparsed, the way a migrated store has them:
 * the page parses each when it first reads it (and stores what it parsed).
 */
export function storedLists(lists) {
  const items = { 'cache.searchLists': {} }
  const index = new Set()
  for (const [key, { scrapedAt, blurbsHtml, descriptor }] of Object.entries(lists)) {
    const ids = []
    for (const html of blurbsHtml) {
      const id = /\bid="work_(\d+)"/.exec(html)?.[1]
      if (!id)
        continue
      const sid = Number(id).toString(36)
      ids.push(sid)
      index.add(Number(id))
      items[`blurb.${sid}`] = { html }
    }
    items['cache.searchLists'][key] = { v: 3, scrapedAt, ids: ids.join(','), ...(descriptor ? { descriptor } : {}) }
  }
  // The index in its packed form: sorted, base-36 deltas.
  let prev = 0
  items.blurbIndex = [...index].sort((a, b) => a - b).map((n) => {
    const delta = (n - prev).toString(36)
    prev = n
    return delta
  }).join(',')
  return items
}

/** The decimal work ids a stored list holds, in order. */
export function storedListIds(list) {
  return list?.ids ? list.ids.split(',').map(sid => String(Number.parseInt(sid, 36))) : []
}
