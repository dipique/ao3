import { posix } from 'node:path'

/** The test tiers, each by the glob its package.json script runs. */
export const TIERS = [
  { name: 'unit', script: 'tests:unit', glob: 'test/!(e2e)/*.test.mjs' },
  { name: 'e2e', script: 'tests:e2e', glob: 'test/e2e/*.test.mjs' },
  { name: 'visual', script: 'tests:e2e:visual', glob: 'test/e2e/visual/*.test.mjs' },
]

/**
 * Files every build or every run reads, which no import graph shows: the
 * build's own config and dependencies, the manifest it starts from, the
 * generated type stubs, and the e2e global setup.
 */
export const ALWAYS_FULL = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'uno.config.ts',
  'eslint.config.*',
  'tsconfig*.json',
  'scripts/builder/**',
  'src/manifest.ts',
  'src/types/**',
  'test/e2e/globalSetup.mjs',
]

/** Files no test runs. */
export const INERT = [
  '**/*.md',
  'docs/**',
  'LICENSE*',
  '.gitignore',
  '.github/**',
  '.vscode/**',
]

/** Files a run itself writes, which are neither tested nor linted. */
export const OUTPUT = [
  '**/*.tsbuildinfo',
]

const matchesAny = (file, globs) => globs.some(glob => posix.matchesGlob(file, glob))

export function tierOf(file) {
  return TIERS.find(tier => posix.matchesGlob(file, tier.glob))?.name ?? null
}

/**
 * Which tests to run for a change, or that only the whole suite will do.
 *
 * `changed` and `deleted` are repo-relative paths; `tests` are
 * `{ file, tier, deps }`, `deps` the set of files the test reaches; `visual` is
 * whether the visual tier is wanted at all. Gives `{ full: true, reasons }`, or
 * `{ full: false, unit, e2e, visual, lint }` with each tier's test files and the
 * files to lint.
 */
export function planVerify({ changed: touched, deleted, tests, visual }) {
  const reasons = []
  const chosen = new Set()
  const changed = touched.filter(file => !matchesAny(file, OUTPUT))

  for (const file of deleted) {
    if (!tierOf(file) && !matchesAny(file, [...INERT, ...OUTPUT]))
      reasons.push(`${file} was deleted, and what used it can't be traced from the files left`)
  }

  for (const file of changed) {
    if (matchesAny(file, ALWAYS_FULL)) {
      reasons.push(`${file} feeds every build or test run`)
      continue
    }
    if (matchesAny(file, INERT))
      continue
    const users = tests.filter(test => test.deps.has(file))
    if (users.length === 0)
      reasons.push(`${file} is imported by no test, so it may be read at run time`)
    users.forEach(test => chosen.add(test))
  }

  if (reasons.length)
    return { full: true, reasons }

  const files = tier => [...chosen].filter(test => test.tier === tier).map(test => test.file).sort()
  return {
    full: false,
    unit: files('unit'),
    e2e: files('e2e'),
    visual: visual ? files('visual') : [],
    lint: [...changed],
  }
}

/**
 * A package.json test script as an argument list, with its quoted `glob`
 * swapped for `files`, so a scoped run keeps every other flag the script sets.
 */
export function scopedCommand(script, glob, files) {
  const args = script.match(/"[^"]*"|\S+/g).map(arg => arg.replace(/^"(.*)"$/, '$1'))
  const at = args.indexOf(glob)
  if (at === -1)
    throw new Error(`"${script}" doesn't run "${glob}"`)
  return [...args.slice(0, at), ...files, ...args.slice(at + 1)]
}
