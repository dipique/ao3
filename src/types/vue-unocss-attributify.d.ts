type UnoAttribute = any

type Attributes = Record<string, UnoAttribute>
type ComponentAttributes = Record<(string & Record<never, never>), UnoAttribute>

declare module '@vue/runtime-dom' {
  interface HTMLAttributes extends Attributes {}
}

declare module '@vue/runtime-core' {
  interface AllowedComponentProps extends ComponentAttributes {}

  // `Icon` is a functional component in a `.ts` file (registered globally in
  // options_ui.ts). unplugin-vue-components only scans `.vue`, so it never lands
  // in the generated `components.d.ts` `GlobalComponents`. Declare it here so the
  // bare `<Icon>` used across the options UI type-checks under `strictTemplates`.
  interface GlobalComponents {
    Icon: typeof import('../options_ui/components/basic/Icon')['default']
  }
}

export {}
