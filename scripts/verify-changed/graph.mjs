import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative } from 'node:path'

/**
 * What a file depends on, as far as reading its source can tell: the files it
 * imports, and — for a file under `test/` — the files it names from the repo
 * root or relative to itself, and the built pages it loads. Repo-relative
 * POSIX paths throughout.
 */

/**
 * The built pages e2e tests load, each known by what a test-side file writes to
 * load it, and the sources it is built from. A root that is a directory stands
 * for every file in it: the options page also takes components and composables
 * it never imports (auto-imported, listed in the generated `src/types/*.d.ts`).
 *
 * The exported site reaches a test only as the file the options page saves, so
 * it is loaded by catching that download.
 */
export const BUNDLES = {
  content: {
    marker: /content_script\.(?:js|css)\b/,
    roots: ['src/content_script'],
  },
  options: {
    marker: /options_ui\.html\b/,
    roots: ['src/options_ui', 'src/types/auto-imports.d.ts', 'src/types/components.d.ts'],
  },
  site: {
    marker: /evaluateOnNewDocument\(\s*captureDownloads\s*\)/,
    roots: ['src/site'],
  },
}

/**
 * Modules the build makes up, by the sources they are made from. The site
 * bundle is data on the options page, run only in an export, which
 * {@link BUNDLES} `site` accounts for.
 */
export const VIRTUAL = {
  'virtual:site-bundle': null,
}

const PARSED = /\.(?:[cm]?[jt]sx?|vue|css)$/
const TRIED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.vue', '.mjs', '.js']

export function importSpecifiers(source) {
  return [...source.matchAll(/(?:\bfrom|\bimport)\s*(?:\(\s*)?['"]([^'"\n]+)['"]/g)].map(m => m[1])
}

export function fileUrls(source) {
  return [...source.matchAll(/new URL\(\s*['"`]([^'"`\n]+)['"`]\s*,\s*import\.meta\.url/g)].map(m => m[1])
}

export function pathLiterals(source) {
  return [...source.matchAll(/['"`]((?:src|test|scripts)\/[\w./-]*)['"`]/g)].map(m => m[1])
}

/** `source` without its comments: a `//` that follows a URL's scheme is no comment. */
export function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

export function bundlesNamed(source) {
  return Object.keys(BUNDLES).filter(name => BUNDLES[name].marker.test(source))
}

/** The graph's view of the repo's file system at `root`. */
export function nodeFs(root) {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return {
    read: path => readFileSync(join(root, path), 'utf8'),
    kind: (path) => {
      const stat = statSync(join(root, path), { throwIfNoEntry: false })
      return stat?.isFile() ? 'file' : stat?.isDirectory() ? 'dir' : null
    },
    list: dir => readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/')),
    aliases: packageJson.imports ?? {},
  }
}

/**
 * The import graph over a file system given as `read(path)`, `kind(path)`
 * (`'file'`, `'dir'` or null) and `list(dir)` (every file under it), all over
 * repo-relative paths, with `aliases` the package.json `imports`.
 */
export function createGraph({ read, kind, list, aliases = {} }) {
  const edges = new Map()

  /** The files `path` stands for: itself, every file under it, or none. */
  function expand(path) {
    const found = kind(path)
    return found === 'file' ? [path] : found === 'dir' ? list(path) : []
  }

  function asFile(path) {
    if (kind(path) === 'file')
      return [path]
    const stem = path.replace(/\.(?:[cm]?js|jsx)$/, '')
    for (const candidate of [...TRIED_EXTENSIONS.map(ext => stem + ext), ...TRIED_EXTENSIONS.map(ext => `${path}/index${ext}`)]) {
      if (kind(candidate) === 'file')
        return [candidate]
    }
    return expand(path)
  }

  function fromRoot(path) {
    const normal = posix.normalize(path)
    return normal.startsWith('..') ? null : normal.replace(/\/$/, '')
  }

  function resolve(specifier, from) {
    const bare = specifier.replace(/\?.*$/, '')
    if (bare.startsWith('virtual:'))
      return bare in VIRTUAL ? (VIRTUAL[bare] ? expand(VIRTUAL[bare]) : []) : expand('src')
    if (bare.startsWith('.')) {
      const path = fromRoot(posix.join(posix.dirname(from), bare))
      return path ? asFile(path) : []
    }
    for (const [key, target] of Object.entries(aliases)) {
      const to = (typeof target === 'string' ? target : Object.values(target)[0]).replace(/^\.\//, '')
      if (key.endsWith('*') && bare.startsWith(key.slice(0, -1)))
        return asFile(to.replace('*', bare.slice(key.length - 1)))
      if (key === bare)
        return asFile(to)
    }
    return []
  }

  function direct(file) {
    if (edges.has(file))
      return edges.get(file)
    const found = new Set()
    if (PARSED.test(file)) {
      const source = read(file)
      for (const specifier of importSpecifiers(source))
        resolve(specifier, file).forEach(path => found.add(path))
      if (file.startsWith('test/')) {
        const code = withoutComments(source)
        for (const url of fileUrls(code)) {
          const path = fromRoot(posix.join(posix.dirname(file), url))
          if (path)
            expand(path).forEach(p => found.add(p))
        }
        for (const literal of pathLiterals(code))
          expand(literal.replace(/\/$/, '')).forEach(path => found.add(path))
        for (const name of bundlesNamed(code))
          BUNDLES[name].roots.flatMap(expand).forEach(path => found.add(path))
      }
    }
    edges.set(file, found)
    return found
  }

  return {
    dependencies(entry) {
      const seen = new Set([entry])
      const queue = [entry]
      while (queue.length) {
        for (const next of direct(queue.pop())) {
          if (!seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
      return seen
    },
  }
}
