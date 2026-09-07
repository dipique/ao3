import * as esbuild from 'esbuild'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { ICONS_CUSTOM_COLLECTIONS, ICONS_TRANSFORM } from '#uno.config'

import type { File } from './utils.ts'

import { AssetBase } from './AssetBase.ts'
import { ALIAS, DEFINE, ESBUILD, IconsPlugin } from './common.ts'
import { logBuild } from './utils.ts'

/**
 * The exported site's own bundle: `src/site/main.ts` and its CSS, compiled to
 * **two strings** rather than to files in `dist/`.
 *
 * It is a build target like the others — same aliases, same icon handling, same
 * browser target — but its output has nowhere to be written. The exporter runs
 * inside the options page and has no filesystem, so the app it inlines into
 * every export has to reach it as *data*: the options build imports these two
 * strings, and the exporter puts them in the file it hands the reader. That is
 * the same constraint that shaped every other part of the export, and the same
 * answer.
 *
 * Bundled with esbuild rather than the options page's Vite: this is a plain
 * script written against our own hyperscript, not a Vue app, and it wants
 * exactly the configuration the content script already builds under.
 */
export class AssetSite extends AssetBase {
  /** The bundled app, as one IIFE. */
  public js = ''
  /** The bundled stylesheet, ours and the page skin it draws on. */
  public css = ''

  private built: Promise<void> | null = null

  constructor(inputPath: string, opts: AssetBase['opts']) {
    super(inputPath, opts, 'site')
    this.reset()
  }

  /** Build once per process; every importer of the bundle gets the same strings. */
  async ensureBuilt(): Promise<void> {
    this.built ??= this.build()
    await this.built
  }

  override async innerBuild(): Promise<void> {
    const result = await esbuild.build({
      entryPoints: [this.inputPath],
      bundle: true,
      write: false,
      metafile: true,
      outdir: join(this.opts.dist, 'site'),
      // One file, so nothing may be split out of it and nothing may be fetched.
      format: 'iife',
      splitting: false,
      sourcemap: false,
      alias: ALIAS(this),
      define: DEFINE(this),
      ...ESBUILD(this),
      plugins: [
        InlineCssPlugin(this),
        IconsPlugin.esbuild({
          customCollections: ICONS_CUSTOM_COLLECTIONS,
          transform: ICONS_TRANSFORM,
        }),
      ],
    })

    for (const file of result.outputFiles ?? []) {
      if (file.path.endsWith('.css'))
        this.css = file.text
      else if (file.path.endsWith('.js'))
        this.js = file.text
    }

    if (!this.js)
      throw new Error(`The site bundle produced no script from ${this.inputPath}`)

    // Reported like every other asset even though none of it lands in dist —
    // the numbers here are most of what a reader downloads that isn't fic.
    logBuild(this.opts, this.inputPath, (result.outputFiles ?? []).map(file => ({
      fileName: file.path,
      contents: file.contents,
      size: file.contents.byteLength,
    } as File)), result.metafile)
  }

  /**
   * Watch mode builds it the once. The app is inlined into an export at the
   * moment the reader asks for one, not served, so there is nothing live for a
   * rebuild to update — restart the build to pick up a change here.
   */
  override async innerServe(): Promise<void> {
    await this.innerBuild()
    this.firstBuild.resolve()
  }
}

/**
 * `.css?inline` as a JS string, the same way the content-script build resolves
 * it — the toast's shadow root carries its own stylesheet in.
 */
function InlineCssPlugin(asset: AssetSite): esbuild.Plugin {
  return {
    name: 'inline-css',
    setup(build) {
      build.onResolve(
        { filter: /\.css\?inline$/ },
        ({ path, resolveDir }) => ({ path: resolve(resolveDir, path), pluginData: { resolveDir } }),
      )
      build.onLoad({ filter: /\.css\?inline$/ }, async ({ path, pluginData }) => {
        const fileName = path.slice(0, path.length - 7)
        const raw = await fs.readFile(fileName, 'utf-8')
        const css = (await build.esbuild.transform(raw, { loader: 'css', ...ESBUILD(asset) })).code
        return {
          contents: `export default ${JSON.stringify(css)}`,
          loader: 'js' as const,
          resolveDir: (pluginData as { resolveDir: string }).resolveDir,
          watchFiles: [fileName],
        }
      })
    },
  }
}
