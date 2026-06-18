import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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

/** Build dist/chrome (production, cross-platform) if it's missing. */
export function ensureBuilt() {
  if (existsSync(join(DIST, 'manifest.json')))
    return
  const res = spawnSync(process.execPath, ['scripts/builder/build.ts', 'build'], {
    cwd: REPO_ROOT,
    env: { ...process.env, BROWSER: 'chrome', NODE_ENV: 'production' },
    stdio: 'inherit',
  })
  if (res.status !== 0)
    throw new Error('Failed to build dist/chrome for e2e test')
}

/** Serve dist/chrome over HTTP. Returns { url, close }. */
export async function serveDist() {
  const server = http.createServer(async (req, res) => {
    try {
      const file = join(DIST, decodeURIComponent(req.url.split('?')[0]))
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
  return { url: `http://localhost:${port}`, close: () => new Promise(r => server.close(r)) }
}

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
      for (const k of ks) if (k in store) out[k] = store[k]
      if (keys && !Array.isArray(keys) && typeof keys === 'object')
        for (const k of Object.keys(keys)) if (!(k in out)) out[k] = keys[k]
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
    remove: (keys) => { (toArr(keys) || []).forEach(k => delete store[k]); return Promise.resolve() },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); return Promise.resolve() },
  })
  const onChanged = { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l), hasListener: l => listeners.has(l) }
  const storage = { local: area('local'), sync: area('sync'), session: area('session'), managed: area('managed'), onChanged }
  const noop = () => {}
  const deep = () => new Proxy(noop, { get: (_t, p) => (p === 'then' ? undefined : deep()), apply: () => undefined })
  const base = {
    storage,
    runtime: { id: 'mock', getURL: p => p, sendMessage: () => Promise.resolve(), connect: () => ({ onMessage: { addListener: noop }, postMessage: noop, onDisconnect: { addListener: noop } }), onMessage: { addListener: noop, removeListener: noop }, getManifest: () => ({ version: '0.0.0' }) },
    i18n: { getMessage: () => '' },
  }
  const chrome = new Proxy(base, { get: (t, p) => (p in t ? t[p] : deep()) })
  window.chrome = chrome
  window.browser = chrome
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))
