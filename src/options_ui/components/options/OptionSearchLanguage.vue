<script setup lang="ts">
import { ref } from 'vue'

import type { Language } from '#common'

import { fetchAndParseDocument, getArchiveLink } from '#common'

const { language } = useOption('searchLanguage')
const options = shallowRef<Language[]>([])
const open = ref(false)

// Load AO3's canonical language list (label + code) the first time the picker is
// opened, from the advanced search page's own dropdown — same source the "hide
// languages" picker uses, so the two stay in sync with the archive.
whenever(open, async () => {
  const doc = await fetchAndParseDocument(getArchiveLink('/works/search'))
  const langSelect = doc.getElementById('work_search_language_id') as HTMLSelectElement | null
  if (!langSelect)
    return
  options.value = [...langSelect.options].filter(option => option.value).map(option => ({
    label: option.text,
    value: option.value,
  }))
}, { once: true })

const query = ref('')
const filteredOptions = computed(() => options.value.filter(option =>
  option.label.toLowerCase().includes(query.value.toLowerCase())
  || option.value.toLowerCase().includes(query.value.toLowerCase())))

// Drive the combobox by the language *code* (a plain string is trivial to
// compare for the selected-state check); on pick we store the full {value,label}
// so the closed button can name it without re-fetching. '' clears the default.
const selectedCode = computed<string>({
  get: () => language.value?.value ?? '',
  set: (value) => {
    const match = options.value.find(option => option.value === value)
    language.value = match ? { ...match } : null
    open.value = false
  },
})
</script>

<template>
  <RekaPopoverRoot v-model:open="open">
    <RekaPopoverTrigger as-child>
      <button
        role="combobox"
        :aria-expanded="open"
        class="btn default"
        border="1 input"
        min-w="200px"
        flex="justify-between"
        text="sm muted-fg"
        min-h-8 px-2 py-2
      >
        {{ language?.label || 'Any language' }}
        <Icon v-if="open" i-mdi-chevron-up />
        <Icon v-else i-mdi-chevron-down />
      </button>
    </RekaPopoverTrigger>
    <RekaPopoverPortal>
      <RekaPopoverContent
        class="animate-popover popover"
        border="b-1"
        z-99 h-full w-full of-hidden rounded-md shadow-md
      >
        <RekaComboboxRoot
          v-model="selectedCode"
          :ignore-filter="true"
          flex="~ col"
          default-open
        >
          <div class="flex items-center px-2" border="1 input">
            <Icon i-mdi-search mr-2 w-4 op-50 />
            <RekaComboboxInput
              v-model="query"
              auto-focus
              flex="~"
              h-8 rounded-md py-3 text-sm outline-none
            />
          </div>

          <RekaComboboxContent max-h="300px" border="1 input" force-mount of-x-hidden of-y-auto>
            <RekaComboboxEmpty py-6 text-center text-sm>
              No results found
            </RekaComboboxEmpty>
            <RekaComboboxGroup>
              <RekaComboboxItem
                class="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-input"
                value=""
              >
                <RekaComboboxItemIndicator>
                  <Icon i-mdi-check mr-2 w-4 />
                </RekaComboboxItemIndicator>
                <span text="muted-fg">Any language</span>
              </RekaComboboxItem>
              <RekaComboboxItem
                v-for="(option, index) in filteredOptions"
                :key="index"
                class="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-input"
                :value="option.value"
              >
                <RekaComboboxItemIndicator>
                  <Icon i-mdi-check mr-2 w-4 />
                </RekaComboboxItemIndicator>
                {{ option.label }}
              </RekaComboboxItem>
            </RekaComboboxGroup>
          </RekaComboboxContent>
        </RekaComboboxRoot>
      </RekaPopoverContent>
    </RekaPopoverPortal>
  </RekaPopoverRoot>
</template>
