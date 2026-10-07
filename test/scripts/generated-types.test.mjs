import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { staleDeclarations } from '../../scripts/generated-types.mjs'

/** The names an auto-imports stub declaring `names` from `module` reports as stale. */
function staleNames(module, ...names) {
  const stub = names.map(name => `  const ${name}: typeof import('../mod').${name}`).join('\n')
  return staleDeclarations('auto-imports.d.ts', stub, spec => (spec === '../mod' ? module : null))
    .map(problem => problem.match(/declares '(\w+)'/)?.[1])
}

describe('staleDeclarations', () => {
  test('reports a name the module does not export', () => {
    assert.deepEqual(staleNames('export function present() {}', 'present', 'stale'), ['stale'])
  })

  test('reports a stub pointing at no module', () => {
    const problems = staleDeclarations('auto-imports.d.ts', `  const x: typeof import('../gone').x`, () => null)
    assert.deepEqual(problems, [`auto-imports.d.ts: 'x' points at '../gone', and no file answers to it`])
  })

  test('accepts any name from a module that re-exports everything', () => {
    assert.deepEqual(staleNames(`export * from './elsewhere'`, 'anything'), [])
  })

  describe('reads no export out of a comment', () => {
    test('a JSDoc line ending in "export" before a "*" line', () => {
      const module = [
        'export function present() {}',
        '',
        '/**',
        ' * Replay a file of changes made inside an export',
        ' * ({@link file://./importChanges.ts}).',
        ' */',
        'function replay() {}',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present', 'stale'), ['stale'])
    })

    test('a line comment', () => {
      const module = [
        `// export * from './elsewhere'`,
        'export function present() {} // export const stale = 1',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present', 'stale'), ['stale'])
    })

    test('a block comment', () => {
      const module = [
        '/*',
        `export * from './elsewhere'`,
        'export { stale }',
        '*/',
        'export /* const stale */ function present() {}',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present', 'stale'), ['stale'])
    })

    test('a JSDoc example', () => {
      const module = [
        '/**',
        ' * @example',
        ' *     export const stale = present()',
        ' */',
        'export function present() {}',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present', 'stale'), ['stale'])
    })
  })

  // Each module below is laid out so that misreading its first literal opens a
  // comment (or a string that ends in one) running on past a real export.
  describe('finds an export after a literal that looks like a comment', () => {
    test('a string holding "//" or "/*"', () => {
      const module = [
        `const GLOB = "src/*.ts"`,
        'export function present() {}',
        `const HOME = 'https://archiveofourown.org'; export function home() {}`,
        '/** A doc comment. */',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present', 'home'), [])
    })

    test('a template literal, with a nested one inside a substitution', () => {
      const module = [
        // eslint-disable-next-line no-template-curly-in-string
        'const a = `${b ? `/*` : \'\'}`',
        'export function present() {}',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present'), [])
    })

    test('a regex literal holding a backtick', () => {
      const module = [
        'const TICK = /`/g',
        'export function present() {}',
        'const t = `/* x`',
        'export function after() {}',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present', 'after'), [])
    })

    test('a regex literal holding "/" in a class', () => {
      const module = [
        'const SLASH_OR_TICK = /[/`]/',
        'export function present() {}',
        'const t = `/* x`',
        'export function after() {}',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present', 'after'), [])
    })

    test('a division that is not a regex', () => {
      const module = [
        'const ratio = total / count + `/`',
        'export function present() {}',
        'const t = `/* x`',
        'export function after() {}',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present', 'after'), [])
    })

    test('a division guessed to be a regex, which never closes on its line', () => {
      const module = [
        'const x = i++ / 2 + `a',
        'b`',
        'export function present() {}',
        'const t = `/* x`',
        'export function after() {}',
      ].join('\n')
      assert.deepEqual(staleNames(module, 'present', 'after'), [])
    })
  })
})
