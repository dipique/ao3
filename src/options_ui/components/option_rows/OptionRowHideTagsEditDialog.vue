<script setup lang="ts">
import type { ComponentInstance, GlobalComponents } from 'vue'

import type { FilterBehavior, TagFilter } from '#common'

import { DEFAULT_HIGHLIGHT_COLOR, TagType } from '#common'

const context = OptionRowHideTagsContext.inject()
const { filters, defaultHighlightColor } = useOption('hideTags')

/** The configured default highlight colour, used when a filter sets none. */
const resolvedDefault = computed(() => defaultHighlightColor?.value || DEFAULT_HIGHLIGHT_COLOR)

const open = ref(false)

const MatcherTypes = [
  ['exact', 'Exact', 'Matches if the tag exactly equals the filter. (default)', 'i-codicon-symbol-string'],
  ['contains', 'Contains', 'Matches if the tag contains the filter. Often used for matching one person in a Relationship tag.', 'i-codicon-whole-word'],
  ['regex', 'Regex', 'Uses regular expressions to match the filter to the tag.', 'i-codicon-regex'],
] as const

const Blank: TagFilter = {
  name: '',
  type: undefined,
  matcher: 'exact',
}

const initial = ref(Blank)
const name = ref(Blank.name)
const type = ref(Blank.type)
const matcher = ref(Blank.matcher)
const behavior = ref<FilterBehavior>('hide')
const color = ref(DEFAULT_HIGHLIGHT_COLOR)
// Invert filters highlight by default; this opts out (stored as a 'transparent' colour).
const noHighlight = ref(false)

const creating = computed(() => toRaw(initial.value) === Blank)

// The colour picker is shown whenever the filter will highlight: any highlight
// filter, or an invert filter that hasn't opted out via "No highlight".
const showColor = computed(() =>
  behavior.value === 'highlight' || (behavior.value === 'invert' && !noHighlight.value))

context.edit = (value?: TagFilter) => {
  open.value = true
  initial.value = value ?? toRaw(Blank)
  name.value = initial.value.name
  type.value = initial.value.type
  matcher.value = initial.value.matcher
  behavior.value = initial.value.behavior ?? 'hide'
  noHighlight.value = initial.value.behavior === 'invert' && initial.value.color === 'transparent'
  color.value = initial.value.color && initial.value.color !== 'transparent'
    ? initial.value.color
    : resolvedDefault.value
}

context.remove = (value: TagFilter) => {
  filters.value.splice(filters.value.indexOf(value), 1)
}

function setDialogRef(ref: unknown) {
  context.editDialog.value = ref as ComponentInstance<GlobalComponents['Dialog']>
}

function save() {
  // Store the default ('hide') as missing, and only keep a colour when the
  // filter highlights. For invert, "No highlight" persists as 'transparent'.
  // When the picked colour just matches the configured default, store nothing so
  // the filter keeps inheriting it (and tracks future changes to the default).
  const behaviorValue = behavior.value === 'hide' ? undefined : behavior.value
  const colorValue
    = behavior.value === 'invert' && noHighlight.value
      ? 'transparent'
      : showColor.value && color.value !== resolvedDefault.value
        ? color.value
        : undefined
  if (creating.value) {
    filters.value.push({ name: name.value, type: type.value, matcher: matcher.value, behavior: behaviorValue, color: colorValue })
  }
  else {
    initial.value.name = name.value
    initial.value.type = type.value
    initial.value.matcher = matcher.value
    initial.value.behavior = behaviorValue
    initial.value.color = colorValue
  }
  open.value = false
}

const typeModel = computed({
  get: () => type.value ?? null,
  set: (v?: string) => type.value = v === null ? undefined : v as TagType,
})
</script>

<template>
  <Dialog :ref="setDialogRef" v-model:open="open" detached-trigger>
    <DialogContent>
      <DialogTitle>
        {{ creating ? 'Create' : 'Edit' }} tag filter
      </DialogTitle>
      <DialogDescription class="sr-only">
        Configure a tag filter: the text to match, how it matches, the tag type to restrict to, and whether matching works are hidden, force-shown, or have the tag highlighted.
      </DialogDescription>
      <div flex="~ col gap-4" pt-4>
        <label flex="~ col gap-1">
          <span text="sm muted-fg">Name filter</span>
          <Input
            v-model="name"
            type="text"
            text="base" h-10 w-full py-2 pl-2 pr-15
          >
            <div absolute inset-y-0 right-2 flex="inline items-center">
              <RekaToggleGroupRoot
                :model-value="matcher"
                type="single"
                @update:model-value="(value) => matcher = (value ?? matcher) as TagFilter['matcher']"
              >
                <RekaToggleGroupItem
                  v-for="[value, label, tooltip, icon] in MatcherTypes"
                  :key="value"
                  :value="value"
                  h-6
                  w-6
                  cursor-pointer
                  rounded-md
                  border="1 transparent state-on:primary"
                  bg="hover:input state-on:primary! state-on:op30!"
                >
                  <Tooltip>
                    <div>
                      <Icon v-bind="{ [icon]: '' }" :label="label" />
                    </div>
                    <template #content>
                      <span>{{ tooltip }}</span>
                    </template>
                  </Tooltip>
                </RekaToggleGroupItem>
              </RekaToggleGroupRoot>
            </div>
          </Input>
        </label>
        <label flex="~ col gap-1">
          <span text="sm muted-fg">Restrict to type</span>
          <Select v-model="typeModel" h-10 w-full>
            <SelectItem :value="null">
              <span text="muted-fg">Any type (do not restrict)</span>
            </SelectItem>
            <SelectItem v-for="t in TagType.values()" :key="t" :value="t">
              {{ TagType.toDisplayString(t) }}
            </SelectItem>
          </Select>
          <p text="xs muted-fg" pl-1>
            See <ArchiveLink path="/faq/tags#tagtypes">this link</ArchiveLink> for explanation of different tag types.
            It is okay to set as "Any type" if you're unsure what type your tag is.
          </p>
        </label>

        <label flex="~ col gap-1">
          <span text="sm muted-fg">Behavior</span>
          <Select v-model="behavior" h-10 w-full>
            <SelectItem value="hide">
              Hide works with matching tags
            </SelectItem>
            <SelectItem value="invert">
              Always show (even if hidden by another rule)
            </SelectItem>
            <SelectItem value="highlight">
              Highlight the tag (does not hide)
            </SelectItem>
          </Select>
        </label>

        <label v-if="behavior === 'invert'" flex="~ items-center gap-2" text="sm">
          <input v-model="noHighlight" type="checkbox">
          <span text="muted-fg">No highlight (don't colour the matching tag)</span>
        </label>

        <label v-if="showColor" flex="~ col gap-1">
          <span text="sm muted-fg">Highlight color</span>
          <ColorInput v-model="color">
            <span text="xs muted-fg">Shown as a highlight behind the tag on results.</span>
          </ColorInput>
        </label>

        <div flex="~ gap-4 justify-end">
          <Button
            text="sm"
            variant="outline"
            @click="open = false"
          >
            Cancel
          </Button>
          <Button
            text="sm"
            variant="default"
            @click="save"
          >
            Save
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
