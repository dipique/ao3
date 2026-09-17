/**
 * Check that every name the generated type stubs declare actually exists.
 *
 * `src/types/auto-imports.d.ts` and `src/types/components.d.ts` are written by
 * unplugin-auto-import / unplugin-vue-components, and both carry `@ts-nocheck`.
 * That is what makes them a blind spot in the only type gate this repo has: a
 * line like
 *
 *     const ago: typeof import('../options_ui/composables/useSiteExport').ago
 *
 * declares a global whose type is an error the compiler has been told not to
 * report, so `vue-tsc` accepts `ago(x)` everywhere and the bundle throws at
 * runtime. Such a line survives a rebuild, too: the plugins only rewrite these
 * files when they decide something changed, so an entry left over from when the
 * symbol *was* exported is never taken back out on its own. Three had
 * accumulated by the time this was written.
 *
 * So: read each referenced module and check the name is really exported from it.
 * Plain Node, no build and no TypeScript — a search for `export` good enough to
 * tell a missing name from a present one, and deliberately not a type checker.
 * It errs towards silence, since a false alarm here costs more than a missed one.
 *
 * Run by `pnpm run lint`, and so by CI.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const TYPES_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'types')
const FILES = ['auto-imports.d.ts', 'components.d.ts']

/**
 * The two shapes the generators emit:
 *
 *     const Foo: typeof import('../mod').Foo          // auto-imports.d.ts
 *     Foo: typeof import('./../Foo.vue')['default']   // components.d.ts
 */
const DECLARATION = /^\s*(?:const\s+|readonly\s+)?(\w+)\s*:\s*typeof\s+import\('([^']+)'\)(?:\['(\w+)'\]|\.(\w+))?/gm

/** Extensions to try for a relative import, in resolution order. */
const EXTENSIONS = ['', '.ts', '.tsx', '.vue', '.d.ts', '/index.ts']

/** The module's source, or null when no file answers to the specifier. */
async function readModule(spec) {
  const base = join(TYPES_DIR, spec)
  for (const ext of EXTENSIONS) {
    try {
      return await readFile(base + ext, 'utf8')
    }
    catch {
      continue
    }
  }
  return null
}

/**
 * Whether `source` exports `name`.
 *
 * Generous on purpose: named declarations, export clauses with or without `as`,
 * and — where a file re-exports everything from somewhere else — a shrug. The
 * case this exists to catch is a name that appears nowhere as an export at all.
 */
function exportsName(source, name) {
  if (new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:const|let|var|function|class|type|interface|enum)\\s+${name}\\b`).test(source))
    return true
  for (const block of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const clause of block[1].split(',')) {
      if ((clause.split(/\s+as\s+/).at(-1) ?? '').trim() === name)
        return true
    }
  }
  return /\bexport\s+\*/.test(source)
}

const problems = []

for (const file of FILES) {
  let source
  try {
    source = await readFile(join(TYPES_DIR, file), 'utf8')
  }
  catch {
    continue // Not every generated stub exists in every checkout.
  }

  for (const [, declared, spec, bracketed, dotted] of source.matchAll(DECLARATION)) {
    // A bare specifier is a package, whose exports are its own business.
    if (!spec.startsWith('.'))
      continue

    const module = await readModule(spec)
    if (module === null) {
      problems.push(`${file}: '${declared}' points at '${spec}', and no file answers to it`)
      continue
    }

    // An SFC's default export is the component; that the file resolves is the
    // whole of the question. Anything else is checked by name.
    const name = bracketed ?? dotted ?? declared
    if (name === 'default' || spec.endsWith('.vue'))
      continue
    if (!exportsName(module, name))
      problems.push(`${file}: declares '${declared}', but '${spec}' does not export '${name}'`)
  }
}

if (problems.length) {
  console.error(`Generated type stubs declare ${problems.length} name(s) that do not exist:\n`)
  for (const problem of problems)
    console.error(`  ${problem}`)
  console.error('\nRemove the stale line(s), or export the symbol they name.')
  process.exit(1)
}

console.log('Generated type stubs are consistent with their sources.')
