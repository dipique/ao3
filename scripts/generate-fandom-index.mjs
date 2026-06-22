// Generates src/data/fandom-index.json: a compact { "lowercased name": id }
// lookup used by the FandomToolbar content-script unit to resolve a displayed
// fandom name to its AO3 tag id without a network request.
//
// Source of truth is the master crossreference produced by the get-fandom-ids
// tooling. Re-run this after merging newly-scraped ids:
//
//   node scripts/generate-fandom-index.mjs
//
// The output is shipped as a web-accessible resource (see manifest.ts) and is
// fetched lazily on works-listing pages.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(here, '../../get-fandom-ids/fandom-json/fandoms.json')
const OUTPUT = resolve(here, '../src/data/fandom-index.json')

const { fandoms } = JSON.parse(readFileSync(SOURCE, 'utf-8'))

const index = {}
let skipped = 0
for (const fandom of fandoms) {
  const { name, id } = fandom
  if (!name || !id) {
    skipped++
    continue
  }
  // Last write wins; canonical names are unique so collisions are unexpected.
  index[name.toLowerCase()] = id
}

// Emit without pretty-printing — this file is machine-loaded and large.
writeFileSync(OUTPUT, JSON.stringify(index))

const count = Object.keys(index).length
const bytes = JSON.stringify(index).length
console.log(`Wrote ${count} fandom ids (${(bytes / 1024).toFixed(0)} KB) to ${OUTPUT}`)
if (skipped)
  console.log(`Skipped ${skipped} entries missing a name or id.`)
