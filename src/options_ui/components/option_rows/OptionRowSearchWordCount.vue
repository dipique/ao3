<script setup lang="ts">
import { formatWordCountRange, NOT_A_WORD_COUNT, parseBoundInput, rangeError } from '#common'

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
    return NOT_A_WORD_COUNT
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
    title="Default word count"
    subtitle="Pre-fills AO3’s Word Count filter with a range. Leave either end blank for a one-sided range, such as “at least 50,000 words”."
  >
    <div flex="~ col gap-2" pt-2>
      <div flex="~ gap-2.5 items-center wrap" py-1 text="[12.5px] muted-fg" leading="[18px]">
        <span shrink-0>Default the word count filter to</span>
        <Input
          v-model="fromText"
          type="text"
          inputmode="numeric"
          placeholder="No min"
          aria-label="Lowest word count"
          class="h-[26px] w-[92px] rounded-[7px] px-2 text-[12.5px] tabular-nums"
        />
        <span shrink-0>to</span>
        <Input
          v-model="toText"
          type="text"
          inputmode="numeric"
          placeholder="No max"
          aria-label="Highest word count"
          class="h-[26px] w-[92px] rounded-[7px] px-2 text-[12.5px] tabular-nums"
        />
        <span shrink-0>words</span>
      </div>
      <p v-if="error" data-error flex="~ items-start gap-1.5" text="[11.5px] default-fg" leading="[16px]">
        <SeverityGlyph severity="destructive" class="mt-px shrink-0 text-[13px]" />
        <span>{{ error }}</span>
      </p>
      <p v-else text="[11.5px] muted-fg" leading="[16px]">
        Filters to {{ formatWordCountRange(parsed!) }} words. Applied only when no word count is set yet, so a range
        already chosen — or one carried in the page URL — is left alone.
      </p>
    </div>
  </OptionRowCollapsable>
</template>
