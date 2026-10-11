import { hasOwnProperty } from '@antfu/utils'
import unocss from '@unocss/vite'
import vue from '@vitejs/plugin-vue'
import type { Ref } from '@vue/reactivity'
import { Buffer } from 'node:buffer'
import { dirname, join, relative, resolve } from 'node:path'
import RekaResolver from 'reka-ui/resolver'
import { visualizer } from 'rollup-plugin-visualizer'
import type { ImportCommon } from 'unimport'
import { builtinPresets } from 'unimport'
import autoImport from 'unplugin-auto-import/vite'
import vueComponents from 'unplugin-vue-components/vite'
import type * as vite from 'vite'

import { ICONS_CUSTOM_COLLECTIONS, ICONS_TRANSFORM } from '#uno.config'

import type { AssetBase } from './AssetBase.ts'
import type { AssetPage, ViteInput } from './AssetPage.ts'
import type { AssetSite } from './AssetSite.ts'
import type { File } from './utils.ts'

import { createAsset } from './Asset.ts'
import { ALIAS, DEFINE, ESBUILD, ESBUILD_TARGET, IconsPlugin, LIGHTNING_CSS_TARGET, MINIFY } from './common.ts'
import { logBuild, makeHash, posixPath, realPath, writeFile } from './utils.ts'

const ORIGIN_PLACEHOLDER = '__VITE_ORIGIN__'

/**
 * A worker started the way Vite finds one to bundle:
 * `new Worker(new URL('./x.ts', import.meta.url))`, or a `SharedWorker`.
 * Group 1 is the `new URL(…)`, group 3 the path in it.
 */
const WORKER_URL_RE = /\bnew\s+(?:Worker|SharedWorker)\s*\(\s*(new\s+URL\s*\(\s*(['"`])([^'"`]+)\2\s*,\s*import\.meta\.url\s*(?:,\s*)?\))/dg

/**
 * Guarantee a usable `localStorage` global before vue-devtools loads. Node 25
 * defines `localStorage` by default but leaves its methods unavailable unless
 * `--localstorage-file` is set, which makes @vue/devtools-kit throw at import.
 * A tiny in-memory shim is all the build/serve process needs.
 */
function ensureLocalStorage(): void {
  const current = (globalThis as { localStorage?: { getItem?: unknown } }).localStorage
  if (current && typeof current.getItem === 'function')
    return

  const store = new Map<string, string>()
  const shim = {
    get length() { return store.size },
    clear() { store.clear() },
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim })
}

export async function createViteConfig(asset: AssetPage, inputs: ViteInput[], origin?: Ref<string | null>) {
  const { opts: { root, src, command } } = asset
  const dist = dirname(join(asset.opts.dist, relative(src, asset.inputPath)))

  // Imported lazily: vite-plugin-vue-devtools pulls in @vue/devtools-kit, which
  // reads `localStorage` at import time. Node 25 defines a `localStorage` global
  // (and `navigator`, so the lib assumes a browser) but leaves its methods
  // unavailable without `--localstorage-file`, so the import otherwise throws
  // "localStorage.getItem is not a function". Shim it, and only load in dev.
  let devtoolsPlugins: vite.PluginOption[] = []
  if (process.env.NODE_ENV === 'development') {
    ensureLocalStorage()
    const { default: VueDevtools } = await import('vite-plugin-vue-devtools')
    devtoolsPlugins = [VueDevtools({ appendTo: inputs[0]!.inputPath })]
  }

  return {
    configFile: false,
    root,
    base: command === 'build' ? `/${dirname(relative(src, asset.inputPath))}` : '/',
    mode: process.env.NODE_ENV,
    clearScreen: false,
    logLevel: 'warn',
    appType: 'custom',
    write: false,
    resolve: { alias: ALIAS(asset) },
    // esbuild is still used by vite for pre-checks
    esbuild: { ...ESBUILD(asset), jsx: 'preserve' },
    oxc: { target: ESBUILD_TARGET(asset), jsx: { runtime: 'classic' } },
    define: {
      ...DEFINE(asset),
      __VUE_OPTIONS_API__: 'false',
    },
    server: {
      origin: ORIGIN_PLACEHOLDER,
      // Transformed as the server starts, which is what finds a worker for
      // `WorkerFilePlugin` to write: it is in `dist/` before the page loads.
      warmup: { clientFiles: inputs.map(input => input.inputPath) },
      cors: {
        origin: [
          /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/,
          /^moz-extension:\/\//,
        ],
      },
    },
    css: {
      transformer: 'lightningcss',
      lightningcss: {
        targets: LIGHTNING_CSS_TARGET(asset),
      },
    },
    // A worker (`new Worker(new URL('./x.ts', import.meta.url))`) is bundled on
    // its own, beside the page. Named as the page's entries are, not hashed:
    // the builder never empties `dist/`, so a hashed name would leave every
    // older copy behind, to be packaged.
    worker: {
      rolldownOptions: {
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: '[name].js',
        },
      },
    },
    build: {
      sourcemap: process.env.NODE_ENV === 'development' ? 'inline' : true,
      target: ESBUILD_TARGET(asset),
      emptyOutDir: false,
      chunkSizeWarningLimit: 1024,
      rolldownOptions: {
        input: inputs.map(input => input.inputPath),
        output: {
          dir: dist,
          entryFileNames: '[name].js',
          chunkFileNames: '[name].js',
          assetFileNames: '[name][extname]',
          banner: `if (!('browser' in self)) { self.browser = self.chrome; }`,
          minify: {
            codegen: {
              removeWhitespace: MINIFY,
              legalComments: 'inline',
            },
            compress: true,
            mangle: MINIFY,
          },
        },
      },
    },
    plugins: [
      vue({
        script: {
          propsDestructure: true,
        },
      }),
      vueComponents({
        dirs: inputs.map(input => join(dirname(input.inputPath), 'components')),
        dts: join(src, 'types/components.d.ts'),
        resolvers: [
          RekaResolver({ prefix: 'Reka' }),
        ],
      }),
      unocss(),
      IconsPlugin.vite({
        customCollections: ICONS_CUSTOM_COLLECTIONS,
        transform: ICONS_TRANSFORM,
      }),
      autoImport({
        parser: 'regex',
        imports: [
          { from: 'vue', imports: builtinPresets.vue.imports.filter(i => !(i as ImportCommon).type) },
          '@vueuse/core',
          { from: 'reka-ui', imports: ['useEmitAsProps', 'useForwardProps', 'useForwardPropsEmits', 'useForwardExpose'] },
        ],
        ignore: ['h'],
        defaultExportByFilename: true,
        dirs: [
          ...inputs.map(input => join(dirname(input.inputPath), 'components/**/use*.ts')),
          ...inputs.map(input => join(dirname(input.inputPath), 'composables/**')),
          ...inputs.map(input => join(dirname(input.inputPath), 'directives/**')),
        ],
        dts: join(src, 'types/auto-imports.d.ts'),
      }),
      AssetPlugin(),
      SiteBundlePlugin(),
      WorkerFilePlugin(),
      {
        name: 'origin',
        transform(code) {
          if (origin && origin.value)
            return code.replaceAll(ORIGIN_PLACEHOLDER, origin.value)
        },
      },
      visualizer({
        filename: join(asset.opts.dist, relative(src, asset.inputPath).replace(/\.html?$/, '.stats.html')),
      }),
      ...devtoolsPlugins,
    ],
  } as vite.InlineConfig

  /**
   * Hands the exported site's app, loader and stylesheet to the options build,
   * as data ({@link file://./AssetSite.ts}).
   *
   * A virtual module rather than a `?raw` import of a file on disk, because
   * there is no file: the bundle is built here, on demand, the first time the
   * options page's module graph reaches it — which is also what puts it ahead of
   * the build that needs it, without either build having to know about the
   * other's schedule.
   */
  function SiteBundlePlugin(): vite.Plugin {
    const id = 'virtual:site-bundle'
    const resolved = `\0${id}`
    return {
      name: 'site-bundle',
      resolveId: source => (source === id ? resolved : undefined),
      async load(loaded) {
        if (loaded !== resolved)
          return
        const site = createAsset(join(src, 'site/main.ts'), asset.opts, 'site') as AssetSite
        await site.ensureBuilt()
        return [
          `export const app = ${JSON.stringify(site.app)}`,
          `export const loader = ${JSON.stringify(site.loader)}`,
          `export const css = ${JSON.stringify(site.css)}`,
        ].join('\n')
      },
    }
  }

  /**
   * Under `serve`, writes each worker the page starts to `dist/`, where the
   * build puts it, and points the page at that file. The page's scripts come
   * from the dev server, so the address Vite would give a worker is the dev
   * server's too, and a page can start a worker only from its own origin: the
   * extension's.
   *
   * A worker is bundled and watched with esbuild, as the background is, for as
   * long as the dev server runs.
   */
  function WorkerFilePlugin(): vite.Plugin {
    const workers = new Map<string, Promise<AssetBase>>()

    function serveWorker(inputPath: string) {
      let served = workers.get(inputPath)
      if (!served) {
        const worker = createAsset(inputPath, asset.opts, 'worker')
        served = worker.serve().then(() => worker)
        workers.set(inputPath, served)
      }
      return served
    }

    return {
      name: 'worker-file',
      apply: 'serve',
      applyToEnvironment: environment => environment.config.consumer === 'client',
      transform: {
        filter: { code: 'import.meta.url' },
        async handler(code, id) {
          const found = [...code.matchAll(WORKER_URL_RE)]
          if (found.length === 0)
            return
          let rewritten = code
          for (const match of found.reverse()) {
            const spec = match[3]!
            const resolved = await this.resolve(spec, id)
            if (!resolved)
              this.error(`No file answers to the worker '${spec}'`)
            const worker = await serveWorker(resolve(resolved.id.replace(/[?#].*$/, '')))
            if (!worker.outputPath.value)
              this.error(`The worker '${spec}' built to nothing`)
            const url = `/${posixPath(relative(asset.opts.dist, worker.outputPath.value))}`
            const [start, end] = match.indices![1]!
            rewritten = `${rewritten.slice(0, start)}new URL(${JSON.stringify(url)}, location.href)${rewritten.slice(end)}`
          }
          return { code: rewritten, map: null }
        },
      },
      async closeBundle() {
        await Promise.all([...workers.values()].map(async served => (await served).stop()))
      },
    }
  }

  function AssetPlugin() {
    return {
      name: 'asset',
      async generateBundle(_, bundle) {
        const files = Object.fromEntries(Object.entries(bundle).map(([fileName, chunk]) => {
          const outputPath = join(dist, fileName)
          const source = chunk.type === 'asset' ? chunk.source : chunk.code
          const contents = typeof source == 'string' ? Buffer.from(source, 'utf-8') : source
          return [outputPath, {
            fileName: outputPath,
            contents,
            size: contents.byteLength,
            hash: makeHash(contents),
          } as File]
        }))

        for (const mapFileName of Object.keys(files)) {
          if (mapFileName.endsWith('.map')) {
            const fileName = mapFileName.replace(/\.map$/, '')
            if (hasOwnProperty(files, fileName)) {
              const file = files[fileName]
              const mapFile = files[mapFileName]
              file!.map = mapFile
            }
          }
        }

        // Write files
        for (const file of Object.values(files))
          await writeFile(file)

        // Print build info
        logBuild(asset.opts, inputs[0]!.inputPath, [...Object.values(files)])

        // Update asset paths
        for (const [fileName, chunk] of Object.entries(bundle)) {
          for (const input of inputs) {
            // Rolldown reports facadeModuleId as the real, symlink/junction-resolved
            // path, while input.inputPath keeps the path the build was invoked with.
            // When the project lives behind a junction (e.g. C:\dev -> another volume),
            // resolve() alone never matches because it normalizes separators but not
            // junctions. realPath() canonicalizes both so the rewrite actually fires.
            if (chunk.type === 'chunk' && chunk.facadeModuleId && realPath(chunk.facadeModuleId) === realPath(input.inputPath)) {
              input.setAttrs(join(dist, fileName), true)
              if (chunk.viteMetadata?.importedCss)
                input.cssBundlePaths = [...chunk.viteMetadata.importedCss].map(p => join(dist, p))
            }
          }
        }
      },
    } as vite.Plugin
  }
}
