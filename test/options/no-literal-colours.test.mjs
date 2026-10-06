import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The options page draws in the theme's tokens (`COLORS` in `uno.config.ts`),
 * which have a light and a dark value each. A hex colour written into a
 * component has one value for both, so it can't follow the theme.
 */

const ROOT = fileURLToPath(new URL('../../src/options_ui/', import.meta.url))

/**
 * Hex colours that are data rather than paint: values stored in the reader's
 * settings, which the page shows as they are.
 */
const ALLOWED = [
  // The colour a new work mark starts with when there is no Read mark to copy.
  { file: 'components/option_rows/OptionRowWorkMarks.vue', colour: '#6b7280' },
]

/** `#abc`, `#abcd`, `#aabbcc` or `#aabbccdd`, not followed by more of a name (`#add-rule`). */
const HEX = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})(?![\w-])/gi

function sources() {
  return readdirSync(ROOT, { recursive: true })
    .map(path => path.replaceAll('\\', '/'))
    .filter(path => /\.(?:vue|ts)$/.test(path))
    .sort()
}

function literalColours(file) {
  const found = []
  readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
    for (const [colour] of line.matchAll(HEX)) {
      if (!ALLOWED.some(allowed => allowed.file === file && allowed.colour === colour.toLowerCase()))
        found.push(`${file}:${i + 1} ${colour}`)
    }
  })
  return found
}

test('the options page names no colour of its own', () => {
  assert.ok(sources().length > 0, 'the options page sources should be found')
  assert.deepEqual(sources().flatMap(literalColours), [])
})
