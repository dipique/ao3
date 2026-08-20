<script setup lang="ts">
import { formatWordCountRange, parseBoundInput, rangeError } from '#common'

const { enabled, from, to } = useOption('searchWordCount')

/**
 * Edited as text for the same reason as the range list: a blank box means "no
 * bound on this side", which no number can stand for. The parsed bounds are
 * written back only once both boxes make a usable range, so a half-typed number
 * never reaches the content script.
 */
const fromText = ref(from.value == null ? '' : String(from.value))
const toText = ref(to.value == null ? '' : String(to.value))

const parsed = computed(() => {
  const parsedFrom = parseBoundInput(fromText.value)
  const parsedTo = parseBoundInput(toText.value)
  if (parsedFrom === undefined || parsedTo === undefined)
    return null
  return { from: parsedFrom, to: parsedTo }
})

const error = computed(() => {
  if (!parsed.value)
    return 'Word counts must be whole numbers of 0 or more.'
  return rangeError(parsed.value)
})

watch(parsed, (range) => {
  if (!range || rangeError(range))
    return
  from.value = range.from
  to.value = range.to
})

// Adopt a range set elsewhere (another device via sync), unless the user is
// part-way through typing one that isn't valid yet.
watch([from, to], ([nextFrom, nextTo]) => {
  if (error.value)
    return
  if ((parsed.value?.from ?? null) !== nextFrom)
    fromText.value = nextFrom == null ? '' : String(nextFrom)
  if ((parsed.value?.to ?? null) !== nextTo)
    toText.value = nextTo == null ? '' : String(nextTo)
})
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Default word count range"
    subtitle="Pre-fill the Word Count filter in the Sort &amp; Filter sidebar"
  >
    <div flex="~ col gap-2" pt-2>
      <div flex="~ gap-2 items-center wrap" py-1>
        <span shrink-0 font="leading-none" text="sm muted-fg">Default the word count filter to</span>
        <Input
          v-model="fromText"
          type="text"
          inputmode="numeric"
          placeholder="No minimum"
          aria-label="Lowest word count"
          text="base" h-9 w-32 py-2 pl-2
        />
        <span shrink-0 text="sm muted-fg">to</span>
        <Input
          v-model="toText"
          type="text"
          inputmode="numeric"
          placeholder="No maximum"
          aria-label="Highest word count"
          text="base" h-9 w-32 py-2 pl-2
        />
        <span shrink-0 text="sm muted-fg">words</span>
      </div>
      <p v-if="error" text="sm destructive" pl-1>
        {{ error }}
      </p>
      <p v-else text="xs muted-fg" pl-1>
        Filters to {{ formatWordCountRange(parsed!) }} words. Applied at the same point as the default search
        language, and only when no word count is set yet — so a range already chosen, or one carried in the page
        URL, is left alone. Leave a box empty for an open-ended range.
      </p>
    </div>
  </OptionRowCollapsable>
</template>
