import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { BUNDLES, bundlesNamed, createGraph, fileUrls, importSpecifiers, nodeFs, pathLiterals } from '../../scripts/verify-changed/graph.mjs'
import { planVerify, scopedCommand, tierOf, TIERS } from '../../scripts/verify-changed/plan.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** A file system of `files` (repo-relative path → text), as the graph reads one. */
function memoryFs(files) {
  const paths = Object.keys(files)
  return {
    read: path => files[path],
    kind: (path) => {
      if (path in files)
        return 'file'
      return paths.some(p => p.startsWith(`${path}/`)) ? 'dir' : null
    },
    list: dir => paths.filter(p => p.startsWith(`${dir}/`)),
  }
}

function graphOf(files, aliases = {}) {
  return createGraph({ ...memoryFs(files), aliases })
}

describe('reading a source file\'s references', () => {
  test('finds every form an import takes', () => {
    const source = [
      `import a from './a.ts'`,
      `import type { B } from "./b.ts"`,
      `import {`,
      `  c,`,
      `} from '#common'`,
      `export * from './d.ts'`,
      `export { e } from './e.ts'`,
      `import './side.css'`,
      `const f = await import('./f.ts')`,
      `@import './g.css';`,
    ].join('\n')
    assert.deepEqual(importSpecifiers(source), ['./a.ts', './b.ts', '#common', './d.ts', './e.ts', './side.css', './f.ts', './g.css'])
  })

  test('finds a file named relative to the module, as a worker or a file read is', () => {
    const source = `new Worker(new URL('../regexWorker.ts', import.meta.url))\nreadFileSync(new URL(\n  '../../src/options_ui/',\n  import.meta.url,\n))`
    assert.deepEqual(fileUrls(source), ['../regexWorker.ts', '../../src/options_ui/'])
  })

  test('finds paths written from the repo root, as an in-page entry is', () => {
    const source = `loadModuleInPage('test/e2e/searchViewEntry.ts', 'SV')\nread("src/site/site.css")\nconst words = 'src is short for source'`
    assert.deepEqual(pathLiterals(source), ['test/e2e/searchViewEntry.ts', 'src/site/site.css'])
  })

  test('tells which built page a fixture loads by the output file it names', () => {
    assert.deepEqual(bundlesNamed(`readFile(join(DIST, 'content_script', 'content_script.js'))`), ['content'])
    assert.deepEqual(bundlesNamed(`page.goto(server.url + '/options_ui/options_ui.html' + hash)`), ['options'])
    assert.deepEqual(bundlesNamed(`import { until } from './helpers.mjs'`), [])
  })
})

describe('walking the import graph', () => {
  test('follows relative imports, trying the TypeScript file for a .js specifier', () => {
    const graph = graphOf({
      'test/a.test.mjs': `import { x } from '../src/x.js'`,
      'src/x.ts': `import { y } from './y'`,
      'src/y.tsx': '',
      'src/unused.ts': '',
    })
    assert.deepEqual([...graph.dependencies('test/a.test.mjs')].sort(), ['src/x.ts', 'src/y.tsx', 'test/a.test.mjs'])
  })

  test('resolves the package\'s own aliases and drops a query', () => {
    const graph = graphOf({
      'src/a.ts': `import { b } from '#common'\nimport c from '#content_script/c.js'\nimport css from './s.css?inline'`,
      'src/common/index.ts': '',
      'src/content_script/c.ts': '',
      'src/s.css': '',
    }, { '#common': './src/common/index.ts', '#content_script/*': './src/content_script/*' })
    assert.deepEqual([...graph.dependencies('src/a.ts')].sort(), ['src/a.ts', 'src/common/index.ts', 'src/content_script/c.ts', 'src/s.css'])
  })

  test('the site bundle the options page carries as data is the site\'s sources only to a test that opens an export', () => {
    const files = {
      'src/options_ui/siteBundle.ts': `import { app } from 'virtual:site-bundle'`,
      'src/site/main.ts': '',
      'src/site/site.css': '',
      'test/e2e/options-x.test.mjs': `import '../../src/options_ui/siteBundle.ts'`,
      'test/e2e/export-x.test.mjs': `import '../../src/options_ui/siteBundle.ts'\nawait page.evaluateOnNewDocument(captureDownloads)`,
    }
    const graph = graphOf(files)
    assert.ok(!graph.dependencies('test/e2e/options-x.test.mjs').has('src/site/site.css'))
    assert.ok(graph.dependencies('test/e2e/export-x.test.mjs').has('src/site/site.css'))
    assert.deepEqual(bundlesNamed('export function captureDownloads() {}'), [])
  })

  test('takes a virtual module it doesn\'t know as all of src, rather than as nothing', () => {
    const graph = graphOf({ 'src/a.ts': `import x from 'virtual:new-thing'`, 'src/b.ts': '' })
    assert.ok(graph.dependencies('src/a.ts').has('src/b.ts'))
  })

  test('ignores packages', () => {
    const graph = graphOf({ 'src/a.ts': `import { ref } from 'vue'\nimport Icon from '~icons/mdi/x.jsx'` })
    assert.deepEqual([...graph.dependencies('src/a.ts')], ['src/a.ts'])
  })

  test('a test depends on every file of the built page its fixture loads', () => {
    const graph = graphOf({
      'test/e2e/x.test.mjs': `import { inject } from './pages.mjs'`,
      'test/e2e/pages.mjs': `readFile(join(DIST, 'content_script', 'content_script.js'))`,
      [`${BUNDLES.content.roots[0]}/units/a.ts`]: '',
      'src/options_ui/App.vue': '',
    })
    const deps = graph.dependencies('test/e2e/x.test.mjs')
    assert.ok(deps.has(`${BUNDLES.content.roots[0]}/units/a.ts`))
    assert.ok(!deps.has('src/options_ui/App.vue'))
  })

  test('a test depends on the entry it bundles into a page, and on the files it reads', () => {
    const graph = graphOf({
      'test/e2e/x.test.mjs': `loadModuleInPage('test/e2e/entry.ts', 'E')\nreadFileSync(new URL('../../src/options_ui/', import.meta.url))`,
      'test/e2e/entry.ts': `import { v } from '../../src/content_script/view.ts'`,
      'src/content_script/view.ts': '',
      'src/options_ui/a/B.vue': '',
    })
    const deps = graph.dependencies('test/e2e/x.test.mjs')
    assert.ok(deps.has('src/content_script/view.ts'))
    assert.ok(deps.has('src/options_ui/a/B.vue'))
  })

  test('only a test-side file is read for paths and pages: src naming them in prose adds nothing', () => {
    const graph = graphOf({
      'test/a.test.mjs': `import { x } from '../src/x.ts'`,
      'src/x.ts': `// the manifest lists content_script.js and 'src/y.ts'`,
      'src/y.ts': '',
      'src/content_script/z.ts': '',
    })
    assert.deepEqual([...graph.dependencies('test/a.test.mjs')].sort(), ['src/x.ts', 'test/a.test.mjs'])
  })

  test('a path or page a test-side file names in a comment is prose, not something it loads', () => {
    const graph = graphOf({
      'test/e2e/helpers.mjs': [
        '/**',
        ' * The build generates into `src/` and writes content_script.js.',
        ' */',
        `const ARCHIVE = 'https://archiveofourown.org' // not 'src/a.ts' either`,
      ].join('\n'),
      'src/a.ts': '',
      'src/content_script/b.ts': '',
    })
    assert.deepEqual([...graph.dependencies('test/e2e/helpers.mjs')], ['test/e2e/helpers.mjs'])
  })

  test('survives an import cycle', () => {
    const graph = graphOf({ 'src/a.ts': `import './b.ts'`, 'src/b.ts': `import './a.ts'` })
    assert.deepEqual([...graph.dependencies('src/a.ts')].sort(), ['src/a.ts', 'src/b.ts'])
  })
})

describe('planning what to verify', () => {
  const options = { file: 'test/e2e/options-x.test.mjs', tier: 'e2e', deps: new Set(['test/e2e/options-x.test.mjs', 'src/options_ui/A.vue', 'src/common/a.ts']) }
  const archive = { file: 'test/e2e/archive-x.test.mjs', tier: 'e2e', deps: new Set(['test/e2e/archive-x.test.mjs', 'test/e2e/pages.mjs', 'src/content_script/b.ts', 'src/common/a.ts']) }
  const look = { file: 'test/e2e/visual/look.test.mjs', tier: 'visual', deps: new Set(['test/e2e/visual/look.test.mjs', 'src/options_ui/A.vue']) }
  const unit = { file: 'test/common/a.test.mjs', tier: 'unit', deps: new Set(['test/common/a.test.mjs', 'src/common/a.ts']) }
  const tests = [options, archive, look, unit]

  function plan(changed, more = {}) {
    return planVerify({ changed, deleted: [], tests, visual: false, ...more })
  }

  test('runs only the tests whose imports reach what changed', () => {
    assert.deepEqual(plan(['src/options_ui/A.vue']), {
      full: false,
      unit: [],
      e2e: [options.file],
      visual: [],
      lint: ['src/options_ui/A.vue'],
    })
    assert.deepEqual(plan(['src/common/a.ts']).e2e, [archive.file, options.file])
    assert.deepEqual(plan(['src/common/a.ts']).unit, [unit.file])
  })

  test('a changed test runs itself, and a changed fixture runs the tests that import it', () => {
    assert.deepEqual(plan([archive.file]).e2e, [archive.file])
    assert.deepEqual(plan(['test/e2e/pages.mjs']).e2e, [archive.file])
  })

  test('the visual tier runs only when asked for', () => {
    assert.deepEqual(plan(['src/options_ui/A.vue'], { visual: true }).visual, [look.file])
  })

  test('prose changes no test, though it is still linted', () => {
    assert.deepEqual(plan(['README.md', 'docs/plans/x.md']), { full: false, unit: [], e2e: [], visual: [], lint: ['README.md', 'docs/plans/x.md'] })
  })

  test('the build info a typecheck rewrites changes no test', () => {
    assert.deepEqual(plan(['tsconfig.node.tsbuildinfo']), { full: false, unit: [], e2e: [], visual: [], lint: [] })
  })

  test('a file every build or run reads falls back to everything', () => {
    for (const file of ['package.json', 'pnpm-lock.yaml', 'uno.config.ts', 'tsconfig.common.json', 'scripts/builder/vite.ts', 'src/manifest.ts', 'src/types/components.d.ts', 'test/e2e/globalSetup.mjs']) {
      const result = plan([file])
      assert.equal(result.full, true, file)
      assert.ok(result.reasons.some(reason => reason.includes(file)), file)
    }
  })

  test('a file no test reaches falls back to everything, since it may be read at run time', () => {
    const result = plan(['src/data/fandom-index.json'])
    assert.equal(result.full, true)
    assert.ok(result.reasons.some(reason => reason.includes('src/data/fandom-index.json')))
  })

  test('a deleted source file falls back to everything; a deleted test or doc does not', () => {
    assert.equal(planVerify({ changed: [], deleted: ['src/content_script/gone.ts'], tests, visual: false }).full, true)
    assert.equal(planVerify({ changed: [], deleted: ['test/e2e/gone.test.mjs', 'docs/gone.md'], tests, visual: false }).full, false)
  })

  test('gives every reason for falling back, not just the first', () => {
    assert.equal(plan(['package.json', 'src/nowhere.ts']).reasons.length, 2)
  })
})

describe('the tiers and their commands', () => {
  const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts

  test('each tier\'s glob is the one its package.json script runs', () => {
    for (const tier of TIERS)
      assert.ok(scripts[tier.script].includes(`"${tier.glob}"`), `${tier.script} doesn't run "${tier.glob}"`)
  })

  test('a file belongs to the tier whose glob takes it', () => {
    assert.equal(tierOf('test/sync/codec.test.mjs'), 'unit')
    assert.equal(tierOf('test/e2e/hide-filters.test.mjs'), 'e2e')
    assert.equal(tierOf('test/e2e/visual/dark-skin.test.mjs'), 'visual')
    assert.equal(tierOf('test/e2e/helpers.mjs'), null)
  })

  test('a scoped run is the tier\'s own command with its glob swapped for the files', () => {
    const script = 'node --test --test-concurrency=3 --test-global-setup=test/e2e/globalSetup.mjs "test/e2e/*.test.mjs"'
    assert.deepEqual(scopedCommand(script, 'test/e2e/*.test.mjs', ['test/e2e/a.test.mjs', 'test/e2e/b.test.mjs']), [
      'node',
      '--test',
      '--test-concurrency=3',
      '--test-global-setup=test/e2e/globalSetup.mjs',
      'test/e2e/a.test.mjs',
      'test/e2e/b.test.mjs',
    ])
    assert.throws(() => scopedCommand('node --test "test/x/*.test.mjs"', 'test/e2e/*.test.mjs', []))
  })
})

describe('the repo\'s own graph', () => {
  const graph = createGraph(nodeFs(ROOT))
  const deps = Object.fromEntries(TIERS.filter(t => t.name !== 'unit')
    .flatMap(t => globSync(t.glob, { cwd: ROOT }))
    .map(file => file.replaceAll('\\', '/'))
    .map(file => [file, graph.dependencies(file)]))

  test('every e2e test reaches some source, so none is skipped for want of a known way to load it', () => {
    for (const [file, reached] of Object.entries(deps))
      assert.ok([...reached].some(path => path.startsWith('src/')), `${file} reaches no file under src/`)
  })

  test('the options page and the AO3 pages have tests apart, so a change to one can skip the other\'s', () => {
    const optionsOnly = Object.values(deps).filter(d => d.has('src/options_ui/OptionsUI.vue') && !d.has('src/content_script/content_script.ts'))
    const archiveOnly = Object.values(deps).filter(d => d.has('src/content_script/content_script.ts') && !d.has('src/options_ui/OptionsUI.vue'))
    assert.ok(optionsOnly.length > 0)
    assert.ok(archiveOnly.length > 0)
  })
})
