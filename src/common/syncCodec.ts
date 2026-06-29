import { isDeepEqual } from '@antfu/utils'

import type { Options } from './options.ts'

/**
 * Pure, browser-free codec for the synced-options payload. Everything here is a
 * plain function over plain data so the whole thing is unit-testable headlessly
 * (`node --test`) — `CompressionStream`/`btoa` are globals in Node 18+.
 *
 * Pipeline (see plans/sync-storage-optimization.md):
 *   prune defaults  ->  canonical JSON  ->  deflate-raw  ->  base64  ->  chunks
 * plus a self-validating manifest (chunk count + generation + content hash +
 * writer token) so a reader can detect a half-propagated or stale chunk set.
 */

/** Bump when the on-the-wire shape changes incompatibly. Older clients refuse to decode a higher version. */
export const SYNC_SCHEMA_VERSION = 1

/** Hard quota of `chrome.storage.sync` (bytes), shared by Chrome and Firefox. */
export const QUOTA_BYTES = 102_400

/** Per-item limit is 8192 bytes incl. key+quotes; stay comfortably under it. */
export const CHUNK_SIZE = 8000

/** Manifest item key (kept short — keys count against the per-item quota). */
export const MANIFEST_KEY = 'om'

/** Chunk item keys are `o0`, `o1`, … */
export const CHUNK_PREFIX = 'o'

/**
 * Option keys never written to sync. `theme` is handled specially (only
 * `theme.chosen` syncs, never the device-derived `theme.current`); `user` is the
 * per-device logged-in AO3 account and `verbose` is a local debug toggle.
 */
export const LOCAL_ONLY = new Set<keyof Options>(['user', 'verbose'])

export interface Manifest {
  /** schema version */
  v: number
  /** chunk count — the authoritative number of `o*` items to reassemble */
  n: number
  /** generation counter (monotonic hint, not an identity) */
  g: number
  /** content hash of the canonical pruned payload */
  h: string
  /** writer token for compare-after-write conflict detection */
  w: string
}

export type DecodeResult
  = | { ok: true, options: Partial<Options> }
    | { ok: false, reason: 'incomplete' | 'corrupt' | 'version' | 'empty' }

// ---------------------------------------------------------------------------
// Pruning / canonicalization / hashing
// ---------------------------------------------------------------------------

/** Drop keys equal to their default and the local-only keys; keep only `theme.chosen` from `theme`. */
export function pruneToSynced(options: Options, defaults: Options): Partial<Options> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(defaults) as (keyof Options)[]) {
    if (LOCAL_ONLY.has(key))
      continue
    if (key === 'theme') {
      if (options.theme?.chosen !== defaults.theme.chosen)
        out.theme = { chosen: options.theme.chosen }
      continue
    }
    if (!isDeepEqual(options[key], defaults[key]))
      out[key] = options[key]
  }
  return out as Partial<Options>
}

/**
 * Rebuild the full local options from a pruned synced payload: defaults overlaid
 * with synced values (so keys absent from the payload are reset to default),
 * while preserving device-local fields (`theme.current`, `user`, `verbose`) from
 * what's already on this device.
 */
export function buildLocalUpdate(pruned: Partial<Options>, defaults: Options, existing: Options): Options {
  const out = { ...defaults, ...pruned } as Options
  out.theme = { ...defaults.theme, ...(pruned.theme ?? {}), current: existing.theme.current }
  for (const key of LOCAL_ONLY)
    (out as Record<string, unknown>)[key] = existing[key]
  return out
}

/** Recursively key-sorted JSON — order-independent so identical data hashes identically across devices. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort())
      out[key] = sortValue((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** cyrb53 — fast, non-cryptographic, 53-bit. Used for change detection / integrity, not security. */
export function hash(str: string, seed = 0): string {
  let h1 = 0xDEADBEEF ^ seed
  let h2 = 0x41C6CE57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// ---------------------------------------------------------------------------
// Compression + base64 (portable — no Uint8Array.toBase64; not in Chrome 120 / FF 117)
// ---------------------------------------------------------------------------

async function transform(bytes: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  // On a decompression error the writable side rejects too; swallow it here so it
  // doesn't surface as an unhandled rejection — the read side's error (below) is
  // the one callers catch.
  writer.write(bytes).catch(() => {})
  writer.close().catch(() => {})
  const buf = await new Response(stream.readable).arrayBuffer()
  return new Uint8Array(buf)
}

const deflateRaw = (bytes: Uint8Array) => transform(bytes, new CompressionStream('deflate-raw'))
const inflateRaw = (bytes: Uint8Array) => transform(bytes, new DecompressionStream('deflate-raw'))

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP)
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP))
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++)
    bytes[i] = bin.charCodeAt(i)
  return bytes
}

// ---------------------------------------------------------------------------
// Encode / decode / diff
// ---------------------------------------------------------------------------

export async function encode(
  options: Options,
  defaults: Options,
  generation: number,
  token: string,
): Promise<{ chunks: Record<string, string>, manifest: Manifest }> {
  const pruned = pruneToSynced(options, defaults)
  const canonical = canonicalStringify(pruned)
  const h = hash(canonical)
  const b64 = bytesToBase64(await deflateRaw(new TextEncoder().encode(canonical)))

  const chunks: Record<string, string> = {}
  const n = Math.max(1, Math.ceil(b64.length / CHUNK_SIZE))
  for (let i = 0; i < n; i++)
    chunks[`${CHUNK_PREFIX}${i}`] = b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)

  return { chunks, manifest: { v: SYNC_SCHEMA_VERSION, n, g: generation, h, w: token } }
}

/**
 * Reassemble + validate a sync payload. `items` is the raw `storage.sync` read
 * (manifest under {@link MANIFEST_KEY}, chunks under `o0`…). Reassembly is driven
 * strictly by `manifest.n` so a stale orphan chunk left mid-propagation is
 * ignored. Returns a discriminated result; callers retry on `incomplete`/`corrupt`
 * (normal mid-propagation states) and permanently skip on `version`.
 */
export async function decode(items: Record<string, unknown>): Promise<DecodeResult> {
  const manifest = items[MANIFEST_KEY] as Manifest | undefined
  if (!manifest || typeof manifest !== 'object' || typeof manifest.n !== 'number')
    return { ok: false, reason: 'empty' }
  if (manifest.v > SYNC_SCHEMA_VERSION)
    return { ok: false, reason: 'version' }

  let b64 = ''
  for (let i = 0; i < manifest.n; i++) {
    const chunk = items[`${CHUNK_PREFIX}${i}`]
    if (typeof chunk !== 'string')
      return { ok: false, reason: 'incomplete' }
    b64 += chunk
  }

  try {
    const str = new TextDecoder().decode(await inflateRaw(base64ToBytes(b64)))
    if (hash(str) !== manifest.h)
      return { ok: false, reason: 'corrupt' }
    return { ok: true, options: JSON.parse(str) as Partial<Options> }
  }
  catch {
    return { ok: false, reason: 'corrupt' }
  }
}

/** Compare chunk maps (manifest excluded): which `o*` items to write, which orphans to remove. */
export function diffChunks(
  prev: Record<string, string>,
  next: Record<string, string>,
): { toSet: Record<string, string>, toRemove: string[] } {
  const toSet: Record<string, string> = {}
  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v)
      toSet[k] = v
  }
  const toRemove = Object.keys(prev).filter(k => !(k in next))
  return { toSet, toRemove }
}
