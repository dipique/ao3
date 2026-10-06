/* eslint-disable perfectionist/sort-imports */
import './reset.css'
// --- comment to keep ./reset.css loaded first ---

import { type Component, createApp } from 'vue'

import { cache, logBanner, options } from '#common'

import Icon from './components/basic/Icon.ts'
import OptionsUI from './OptionsUI.vue'

import 'uno.css'

logBanner()

/** A per-device key this page has no reader for, deleted so the browser doesn't keep it. */
const UNREAD_LOCAL_KEY = 'ao3e:options:descriptions'
try {
  localStorage.removeItem(UNREAD_LOCAL_KEY)
}
catch {
  // Storage is blocked, so there is nothing kept to delete.
}

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
