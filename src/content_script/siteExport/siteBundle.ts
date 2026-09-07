import { css, js } from 'virtual:site-bundle'

import type { SiteBundle } from './payload.ts'

/**
 * The app and stylesheet an export carries, as the exporter sees them.
 *
 * One module, and a leaf, so everything else about building an export stays
 * plain data: {@link file://./payload.ts} takes these two strings as an argument
 * and can be checked without a bundler anywhere near it, and only
 * {@link file://./exportSite.ts} — which already reads storage — depends on
 * there having been a build.
 *
 * The specifier resolves to no file on disk. The site's own bundle is compiled
 * as part of this build and injected here as two strings, because the exporter
 * runs in the options page and has no filesystem to read a bundle out of.
 */

export const siteBundle: SiteBundle = { js, css }
