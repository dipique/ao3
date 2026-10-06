<script lang="ts" setup>
import OptionsUICategories from './categories/OptionsUICategories.vue'
import { shownTheme } from './model/theme.ts'

const ready = useOptionsReady()
const themeOption = useOption('theme')

// `options_ui.html#search`, `#work-text`, `#work-text-reader-mode` — see
// {@link file://./composables/useHashNav.ts}.
useHashNav(ready)

watch(() => themeOption, () => {
  const current = shownTheme({ chosen: themeOption.chosen.value, current: themeOption.current.value })
  document.body.classList.toggle('dark', current === 'dark')
  document.body.classList.toggle('light', current === 'light')
}, { deep: true, immediate: true })

watch(ready, () => document.body.classList.toggle('ready', ready.value), { immediate: true })
</script>

<template>
  <RekaTooltipProvider :delay-duration="300">
    <template v-if="ready">
      <TopBar />
      <div class="md:grid md:grid-cols-[248px_minmax(0,1fr)]">
        <Rail />
        <main id="main" min-w-0 class="px-3 pb-5 pt-3.5 md:px-10 md:pb-10 md:pt-6.5">
          <OptionsUICategories />
          <div class="md:hidden" border="t-1" pt-3>
            <PageFoot />
          </div>
        </main>
      </div>
    </template>
  </RekaTooltipProvider>
</template>

<style>
/* How far the sticky top bar reaches down the page — and, below 768 px, the
   chip row under it. Every jump target keeps clear of it with
   `scroll-margin-top`. */
:root {
  --shell-top: calc(3rem + 2.75rem);
}
@media (min-width: 768px) {
  :root {
    --shell-top: 52px;
  }
}

body {
  overflow-y: auto;
  scroll-behavior: smooth;

  font-size: 16px;

  --at-apply: font-sans;
}
@media (prefers-reduced-motion: reduce) {
  body {
    scroll-behavior: auto;
  }
}

body.ready {
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-default-fg));
}

h1,
h2,
h3,
h4,
h5,
h6 {
  --at-apply: font-serif;
}

/* What a `#hash` jump landed on. A scroll alone leaves you looking at a page
   that moved without saying why — especially when the target is one row in the
   middle of a long list — so the arrival is marked for a moment and then gets
   out of the way. */
.ao3e-jump-flash {
  animation: ao3e-jump-flash 1.6s ease-out;
}

@keyframes ao3e-jump-flash {
  from {
    background-color: rgb(var(--color-accent) / 0.35);
  }
  to {
    background-color: rgb(var(--color-accent) / 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ao3e-jump-flash {
    animation: none;
    outline: 2px solid rgb(var(--color-accent));
    outline-offset: 2px;
  }
}

/* Search hits. The reset zeroes `mark`'s background along with everything else's,
   so the highlight has to be restated — as a tint of the accent colour, which is
   already defined for both themes. */
mark {
  background-color: rgb(var(--color-accent) / 0.4);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
</style>
