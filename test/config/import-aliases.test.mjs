import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The import aliases in `package.json` (`#common`, `#icons/*`, …) each name
 * something that is there: a file, or for an alias ending in `/*`, a
 * directory. One left naming nothing reads as a place code can import from.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const { imports } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('every import alias names a file or a directory that exists', () => {
  const missing = Object.entries(imports)
    .filter(([, target]) => !existsSync(join(ROOT, target.replace(/\/\*$/, ''))))
    .map(([alias, target]) => `${alias} → ${target}`)
  assert.deepEqual(missing, [])
})
