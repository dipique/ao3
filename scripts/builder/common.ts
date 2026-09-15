import { objectMap } from '@antfu/utils'
import type * as esbuild from 'esbuild'
import { resolve } from 'node:path'
import type { UnpluginOptions } from 'unplugin'
import { createUnplugin } from 'unplugin'
import type { Options as UnpluginIconsOptions } from 'unplugin-icons'
import icons from 'unplugin-icons'

import type { AssetBase } from './AssetBase.ts'

import pJson from '../../package.json' with { type: 'json' }

export const BROWSERS = ['chrome', 'firefox'] as const
export type Browser = typeof BROWSERS[number]

export const ESBUILD_TARGET = (asset: AssetBase) => Object.entries(asset.opts.target).map(([k, v]) => `${k}${v}`).join(' ')
export const LIGHTNING_CSS_TARGET = (asset: AssetBase) => objectMap(asset.opts.target, (k, v) => ([k, (v << 16)]))

/**
 * Whether this build ships. Production output is fully minified — whitespace and
 * local names as well as syntax — with an external source map beside it for
 * debugging and the source archive for store review; development keeps both, so
 * what runs in the browser still reads like the source.
 */
export const MINIFY = process.env.NODE_ENV === 'production'

export const ESBUILD = (asset: AssetBase): esbuild.CommonOptions => ({
  target: ESBUILD_TARGET(asset),
  treeShaking: true,
  legalComments: 'none',
  minifySyntax: true,
  platform: 'neutral',
  minifyWhitespace: MINIFY,
  minifyIdentifiers: MINIFY,
})

export const ALIAS = (asset: AssetBase): Record<string, string> => {
  return objectMap(pJson.imports, (v, k) => ([v, resolve(asset.opts.root, k)] as [string, string]))
}

/**
 * One id per builder run, shared by every bundle it writes and by the
 * `build.json` beside the manifest. The background compares its own copy with
 * that file to notice it's running code older than what's on disk — Chrome can
 * keep serving an unpacked extension's cached service worker across rebuilds
 * and browser restarts, since the manifest version never changes. A `serve`
 * session keeps one id throughout, so its rebuilds don't count as stale.
 */
export const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const DEFINE = (asset: AssetBase): Record<string, string> => ({
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
  'process.env.BROWSER': JSON.stringify(process.env.BROWSER),
  'process.env.CONTEXT': JSON.stringify(asset.type),
  'process.env.BUILD_ID': JSON.stringify(BUILD_ID),
})

export const IconsPlugin = createUnplugin<UnpluginIconsOptions>((options, meta) => {
  const ext = 'jsx'
  const raw = icons.raw({
    ...options,
    autoInstall: true,
    compiler: { compiler: (svg: string) => `import * as React from '#dom';\nexport default (${svg})` },
  }, meta as any) as UnpluginOptions
  const regexp = new RegExp(`^~icons/(.+?)\\.${ext}$`)
  return {
    name: `icons-${ext}`,
    enforce: 'pre',
    resolveId(id) {
      const m = id.match(regexp)
      return m && `~icons/${ext}/${m[1]}.jsx`
    },
    loadInclude: id => id.includes(`~icons/${ext}/`),
    async load(id) {
      const handler = 'handler' in raw.load! ? raw.load!.handler : raw.load!
      const loaded = await handler.call(this, id.replace(`~icons/${ext}/`, `~icons/`))
      return loaded && (loaded as { code: string }).code
    },
  } as UnpluginOptions
})
