/* eslint-disable perfectionist/sort-imports */
import './reset.css'
// --- comment to keep ./reset.css loaded first ---

import { type Component, createApp } from 'vue'

import { cache, options } from '#common'

import Icon from './components/basic/Icon.ts'
import OptionsUI from './OptionsUI.vue'

import 'uno.css'

if (process.env.NODE_ENV === 'development') {
  // Allow manual testing access to the option and cache object
  ;(globalThis as any).options = options
  ;(globalThis as any).cache = cache
}

const app = createApp(OptionsUI)
// `Icon` is a functional component in a `.ts` file, so unplugin-vue-components
// (which only scans `.vue`) never auto-imports it; register it globally so the
// bare `<Icon>` used across the options UI resolves without a per-file import.
// Cast: Icon's `i-${string}` mapped-props type doesn't structurally match the
// `Component` parameter, though it's a valid functional component at runtime.
app.component('Icon', Icon as unknown as Component)
app.mount('#app')
