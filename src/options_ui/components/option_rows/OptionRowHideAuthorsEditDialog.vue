<script setup lang="ts">
import type { ComponentInstance, GlobalComponents } from 'vue'

import type { AuthorFilter, FilterBehavior } from '#common'

import { DEFAULT_AUTHOR_HIGHLIGHT_COLOR } from '#common'

const context = OptionRowHideAuthorsContext.inject()
const { filters, defaultHighlightColor } = useOption('hideAuthors')

/** The configured default highlight colour, used when a filter sets none. */
const resolvedDefault = computed(() => defaultHighlightColor?.value || DEFAULT_AUTHOR_HIGHLIGHT_COLOR)

const open = ref(false)

const Blank: AuthorFilter = {
  userId: '',
  pseud: '',
}

const initial = ref(Blank)
const userId = ref(Blank.userId)
// Kept as a plain string (never undefined) so the text Input's model type fits;
// an empty string is normalised back to `undefined` on save.
const pseud = ref(Blank.pseud ?? '')
const behavior = ref<FilterBehavior>('hide')
const color = ref(DEFAULT_AUTHOR_HIGHLIGHT_COLOR)
// Invert filters highlight by default; this opts out (stored as a 'transparent' colour).
const noHighlight = ref(false)

const creating = computed(() => toRaw(initial.value) === Blank)

// The colour picker is shown whenever the filter will highlight: any highlight
// filter, or an invert filter that hasn't opted out via "No highlight".
const showColor = computed(() =>
  behavior.value === 'highlight' || (behavior.value === 'invert' && !noHighlight.value))

context.edit = (value?: AuthorFilter) => {
  open.value = true
  initial.value = value ?? toRaw(Blank)
  userId.value = initial.value.userId
  pseud.value = initial.value.pseud ?? ''
  behavior.value = initial.value.behavior ?? 'hide'
  noHighlight.value = initial.value.behavior === 'invert' && initial.value.color === 'transparent'
  color.value = initial.value.color && initial.value.color !== 'transparent'
    ? initial.value.color
    : resolvedDefault.value
}

context.remove = (value: AuthorFilter) => {
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
    filters.value.push({ userId: userId.value, pseud: pseud.value || undefined, behavior: behaviorValue, color: colorValue })
  }
  else {
    initial.value.userId = userId.value
    initial.value.pseud = pseud.value || undefined
    initial.value.behavior = behaviorValue
    initial.value.color = colorValue
  }
  open.value = false
}
</script>

<template>
  <Dialog :ref="setDialogRef" v-model:open="open" detached-trigger>
    <DialogContent>
      <DialogTitle>
        {{ creating ? 'Create' : 'Edit' }} author filter
      </DialogTitle>
      <DialogDescription class="sr-only">
        Configure an author filter by user ID and optional pseud, and whether matching works are hidden, force-shown, or have the author's byline highlighted.
      </DialogDescription>
      <div flex="~ col gap-4" pt-4>
        <label flex="~ col gap-1">
          <span text="sm muted-fg">User ID filter</span>
          <Input
            v-model="userId"
            type="text"
            text="base" h-10 w-full py-2 pl-2 pr-15
          />
        </label>
        <label flex="~ col gap-1">
          <span text="sm muted-fg">Pseud filter</span>
          <Input
            v-model="pseud"
            type="text"
            text="base" h-10 w-full py-2 pl-2 pr-15
          />
          <p text="xs muted-fg" pl-1>
            An author filter will by default match all that author's pseudonyms. If you want to restrict the filter to only match works by the author under a specific pseudonym, enter the pseudonym here.
          </p>
        </label>

        <label flex="~ col gap-1">
          <span text="sm muted-fg">Behavior</span>
          <Select v-model="behavior" h-10 w-full>
            <SelectItem value="hide">
              Hide works by matching authors
            </SelectItem>
            <SelectItem value="invert">
              Always show (even if hidden by another rule)
            </SelectItem>
            <SelectItem value="highlight">
              Highlight the author (does not hide)
            </SelectItem>
          </Select>
        </label>

        <label v-if="behavior === 'invert'" flex="~ items-center gap-2" text="sm">
          <input v-model="noHighlight" type="checkbox">
          <span text="muted-fg">No highlight (don't colour the matching byline)</span>
        </label>

        <label v-if="showColor" flex="~ col gap-1">
          <span text="sm muted-fg">Highlight color</span>
          <ColorInput v-model="color">
            <span text="xs muted-fg">Shown as a highlight behind the author's byline on results.</span>
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
