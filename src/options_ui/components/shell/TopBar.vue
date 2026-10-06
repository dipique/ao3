<script setup lang="ts">
import { shownTheme, toggledTheme } from '../../model/theme.ts'

const { query, searching, total, clear } = useOptionSearch()

/**
 * A second control for Appearance → Extension theme: both edit the one stored
 * choice, so each shows the other's change as it is made.
 */
const theme = useOption('theme')
const showing = computed(() => shownTheme({ chosen: theme.chosen.value, current: theme.current.value }))
const switchTo = computed(() => toggledTheme({ chosen: theme.chosen.value, current: theme.current.value }))

function switchTheme() {
  theme.chosen.value = switchTo.value
}

const field = ref<HTMLInputElement | null>(null)
const opener = ref<HTMLButtonElement | null>(null)

/**
 * Below 768 px the search is an icon until it's opened, or while a query runs,
 * so a query never filters the page from a field out of sight; wider, the field
 * always shows.
 */
const open = ref(false)
const expanded = computed(() => open.value || searching.value)

function openSearch() {
  open.value = true
  void nextTick(() => field.value?.focus())
}

/** Clear and close the search. Where that hides the field, the focus goes back to the icon. */
function closeSearch() {
  clear()
  open.value = false
  void nextTick(() => {
    if (!field.value?.getClientRects().length)
      opener.value?.focus()
  })
}

function clearSearch() {
  clear()
  field.value?.focus()
}

// `/` jumps to the search from anywhere on the page; Escape leaves it again.
useEventListener(document, 'keydown', (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null
  const inField = /^(?:input|textarea|select)$/i.test(target?.tagName ?? '')
  if (event.key === '/' && !inField && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    openSearch()
  }
  else if (event.key === 'Escape' && target === field.value) {
    closeSearch()
  }
  else if (event.key === 'Escape' && inField && query.value) {
    clear()
  }
})
</script>

<template>
  <header
    class="h-12 flex items-center gap-2 px-3 md:grid md:grid-cols-[248px_minmax(0,1fr)_auto] md:h-[52px] md:gap-0 md:pl-0 md:pr-5"
    pos="sticky top-0" z-50 border="b-1" bg-card
  >
    <div :class="expanded ? 'hidden md:flex' : 'flex'" class="md:pl-4.5" min-w-0 items-center gap-2>
      <Icon i-ao3e-icon h-6 w-6 shrink-0 />
      <span font="serif 600" text="[15px]" truncate>AO3 Enhancements</span>
    </div>

    <div :class="expanded ? 'flex' : 'hidden md:flex'" min-w-0 flex-1 justify-center>
      <div
        class="md:max-w-[340px] focus-within:ring-3 focus-within:ring-ring/50"
        flex="~ items-center gap-2" h="[30px]"
        border="1 input" w-full rounded-lg bg-default px-2.5 text-muted-fg
      >
        <Icon i-mdi-magnify shrink-0 text-base />
        <input
          ref="field"
          v-model="query"
          type="text"
          :placeholder="`Search ${total} settings`"
          aria-label="Search settings by name or description"
          autocomplete="off"
          spellcheck="false"
          min-w-0 flex-1 bg-transparent text="[13px] default-fg" outline-none
        >
        <button
          v-if="query"
          class="hidden input-ring md:grid"
          text="muted-fg hover:default-fg" h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-md
          aria-label="Clear the settings search"
          @click="clearSearch"
        >
          <Icon i-mdi-close-circle />
        </button>
        <kbd v-else class="hidden md:inline" border="1" rounded px-1.5 text="[10.5px]">/</kbd>
        <button
          v-if="expanded"
          class="grid input-ring md:hidden"
          text="muted-fg hover:default-fg" h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-md
          aria-label="Close the settings search"
          @click="closeSearch"
        >
          <Icon i-mdi-close />
        </button>
      </div>
    </div>

    <div flex="~ items-center gap-1.5" ml-auto shrink-0>
      <button
        v-if="!expanded"
        ref="opener"
        class="grid input-ring md:hidden"
        h-9 w-9 cursor-pointer place-items-center rounded-lg text="muted-fg lg hover:default-fg"
        aria-label="Search settings"
        @click="openSearch"
      >
        <Icon i-mdi-magnify />
      </button>
      <button
        class="h-9 w-9 input-ring md:h-8 md:w-8"
        grid cursor-pointer place-items-center rounded-lg text="muted-fg lg hover:default-fg"
        :aria-label="`Switch to ${switchTo} theme`"
        :title="`Switch to ${switchTo} theme`"
        @click="switchTheme"
      >
        <Icon v-if="showing === 'dark'" i-mdi-weather-night />
        <Icon v-else i-mdi-white-balance-sunny />
      </button>
    </div>
  </header>
</template>
