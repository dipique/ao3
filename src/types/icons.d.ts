/**
 * Modules the bundler resolves but the compiler can't see on its own.
 *
 * Deliberately no `*.vue` shim: `pnpm run typecheck` runs `vue-tsc`, which reads
 * the SFCs themselves and gives each import its real prop and emit types. An
 * ambient `declare module '*.vue'` would shadow those with an opaque
 * `ComponentOptions` and silently switch off template checking. (Plain `tsc -b`
 * therefore can't resolve `.vue` imports — that's expected; use the script.)
 */
declare module '~icons/*.jsx' {
  const component: (props: JSX.SVGAttributes<SVGSVGElement>) => JSX.Element
  export default component
}

/**
 * The exported site's app and stylesheet, bundled by the build and handed to the
 * options build as two strings — the exporter runs in a page and has no
 * filesystem, so what it inlines into an export has to reach it as data. There
 * is no file behind this specifier; the builder produces it on demand.
 */
declare module 'virtual:site-bundle' {
  export const js: string
  export const css: string
}
