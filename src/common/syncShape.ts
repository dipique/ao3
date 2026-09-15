import type { Options } from './options.ts'

import { LOCAL_ONLY } from './syncCodec.ts'

/**
 * The shape of what sync carries: every synced option, and the structure (not
 * the value) of its default. `test/sync/compat.test.mjs` compares it with the
 * shape recorded for the current {@link file://./syncCodec.ts} sync version, so
 * an option added, removed or restructured can't ship without a version bump.
 *
 * Kept out of the codec, which the content script also loads: nothing but that
 * test needs it.
 */

/**
 * Option paths whose keys are data rather than schema — mark ids, rule targets.
 * Their values are merged into one shape under `'*'`, so shipping a new default
 * mark isn't mistaken for a new option.
 */
export const SYNC_SHAPE_RECORD_PATHS: readonly string[] = ['workMarks.marks', 'rules.colors']

export type Shape = string | ['array', Shape] | { [key: string]: Shape }

export function syncShape(defaults: Options): { [key: string]: Shape } {
  const out: { [key: string]: Shape } = {}
  for (const key of (Object.keys(defaults) as (keyof Options)[]).sort()) {
    if (LOCAL_ONLY.has(key))
      continue
    // Only `theme.chosen` syncs; `theme.current` is derived on each device.
    const value = key === 'theme' ? { chosen: defaults.theme.chosen } : defaults[key]
    out[key] = shapeOf(value, key)
  }
  return out
}

function shapeOf(value: unknown, path: string): Shape {
  if (value === null)
    return 'null'
  if (Array.isArray(value))
    return ['array', merge(value.map(entry => shapeOf(entry, `${path}[]`)))]
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (SYNC_SHAPE_RECORD_PATHS.includes(path))
      return { '*': merge(entries.map(([, entry]) => shapeOf(entry, `${path}.*`))) }
    return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, entry]) => [key, shapeOf(entry, `${path}.${key}`)]))
  }
  return typeof value
}

/**
 * One shape standing for several values: objects contribute the union of their
 * keys (a key some entries lack is still part of the shape), and differing
 * leaves are listed together, sorted — `'null|number'`. `'empty'` when there's
 * nothing to go on.
 */
function merge(shapes: Shape[]): Shape {
  if (!shapes.length)
    return 'empty'
  if (shapes.every(shape => isRecord(shape))) {
    const keys = [...new Set(shapes.flatMap(shape => Object.keys(shape)))].sort()
    return Object.fromEntries(keys.map(key => [key, merge(shapes.flatMap(shape => (key in (shape as object) ? [(shape as Record<string, Shape>)[key]!] : [])))]))
  }
  const distinct = [...new Set(shapes.map(shape => JSON.stringify(shape)))].sort()
  return distinct.length === 1 ? shapes[0]! : distinct.map(text => (text.startsWith('"') ? JSON.parse(text) as string : text)).join('|')
}

function isRecord(shape: Shape): shape is { [key: string]: Shape } {
  return typeof shape === 'object' && !Array.isArray(shape)
}
