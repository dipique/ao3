<script setup lang="ts">
import type { ComponentInstance, GlobalComponents } from 'vue'

import type { EntityFilter, FilterBehavior, options } from '#common'

const props = defineProps<{
  /** Which option list this row edits. */
  optionKey: 'hideWorks' | 'hideSeries'
  /** Collapsable row title, e.g. "Works". */
  title: string
  /** Collapsable row subtitle. */
  subtitle: string
  /** Singular noun used in labels, e.g. "work" / "series". */
  noun: string
  /** Built-in default highlight colour for this kind. */
  defaultColor: string
}>()

const { enabled, filters, defaultHighlightColor } = useOption(props.optionKey as options.Id) as unknown as {
  enabled: Ref<boolean>
  filters: Ref<EntityFilter[]>
  defaultHighlightColor: Ref<string | undefined>
}

/** The configured default highlight colour, falling back to the built-in default. */
const resolvedDefault = computed(() => defaultHighlightColor.value || props.defaultColor)

// Backed by an optional stored value; fall back to the built-in default so the
// colour control always has a concrete value to show.
const defaultColorModel = computed({
  get: () => defaultHighlightColor.value || props.defaultColor,
  set: (v: string) => defaultHighlightColor.value = v,
})

const FiltersDataTable = useDataTable<EntityFilter>()

function renderData(filters: EntityFilter[]) {
  return filters
    .map((filter, index) => [index, filter] as [number, EntityFilter])
    .sort(([_ai, a], [_bi, b]) => a.value.localeCompare(b.value))
}

const MatcherTypes = [
  ['exact', 'Exact', 'Matches if the name exactly equals the filter. A numeric value always matches the id. (default)', 'i-codicon-symbol-string'],
  ['contains', 'Contains', 'Matches if the name contains the filter text.', 'i-codicon-whole-word'],
  ['regex', 'Regex', 'Uses a regular expression to match the name.', 'i-codicon-regex'],
] as const

// --- Edit dialog state -----------------------------------------------------

const editDialog = ref<ComponentInstance<GlobalComponents['Dialog']> | null>(null)
const open = ref(false)

const Blank: EntityFilter = { value: '', matcher: 'exact' }

const initial = ref(Blank)
const value = ref(Blank.value)
const matcher = ref<EntityFilter['matcher']>(Blank.matcher)
const behavior = ref<FilterBehavior>('hide')
const color = ref(props.defaultColor)
// Invert filters highlight by default; this opts out (stored as a 'transparent' colour).
const noHighlight = ref(false)

const creating = computed(() => toRaw(initial.value) === Blank)
const isNumericValue = computed(() => /^\d+$/.test(value.value.trim()))

// The colour picker is shown whenever the filter will highlight: any highlight
// filter, or an invert filter that hasn't opted out via "No highlight".
const showColor = computed(() =>
  behavior.value === 'highlight' || (behavior.value === 'invert' && !noHighlight.value))

function edit(filter?: EntityFilter) {
  open.value = true
  initial.value = filter ?? toRaw(Blank)
  value.value = initial.value.value
  matcher.value = initial.value.matcher
  behavior.value = initial.value.behavior ?? 'hide'
  noHighlight.value = initial.value.behavior === 'invert' && initial.value.color === 'transparent'
  color.value = initial.value.color && initial.value.color !== 'transparent'
    ? initial.value.color
    : resolvedDefault.value
}

function remove(filter: EntityFilter) {
  filters.value.splice(filters.value.indexOf(filter), 1)
}

function setDialogRef(ref: unknown) {
  editDialog.value = ref as ComponentInstance<GlobalComponents['Dialog']>
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
    filters.value.push({ value: value.value, matcher: matcher.value, behavior: behaviorValue, color: colorValue })
  }
  else {
    initial.value.value = value.value
    initial.value.matcher = matcher.value
    initial.value.behavior = behaviorValue
    initial.value.color = colorValue
  }
  open.value = false
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    :title="title"
    :subtitle="subtitle"
  >
    <div mx="-4" relative mt-4>
      <div mx="sm:4" max-h-96 overflow-auto border rounded-md bg-default>
        <FiltersDataTable
          :id="`${optionKey}-filters`"
          :data="filters"
          :render-data="renderData"
          text="sm"
          w-full
          class="[&_td,&_th]:h-7 [&_td,&_th]:min-h-7 [&_td,&_th]:align-middle"
        >
          <template #header="{ inner }">
            <th scope="col" sticky top-0 z-10 bg-default text-muted-fg font-medium>
              <div flex="~ items-center justify-center " h-8 border-b>
                <Render :render="inner" />
              </div>
            </th>
          </template>
          <template #row="{ inner, row }">
            <tr
              bg="hover:muted/50"
              transition-colors
              class="[&:not(:last-child)]:border-b"
              @dblclick="edit(row.data)"
            >
              <Render :render="inner" />
            </tr>
          </template>
          <FiltersDataTable.Column accessor="behavior">
            <template #cell="cell">
              <td w-1>
                <Tooltip>
                  <div flex="~ items-center justify-center" h-full px-2 text="4">
                    <Icon
                      v-if="cell.value === 'highlight'"
                      i-mdi-star
                      :style="{ color: cell.row.data.color || resolvedDefault }"
                      label="Highlight"
                    />
                    <Icon v-else-if="cell.value === 'invert'" i-tabler-eye-exclamation op100 label="Show" />
                    <Icon v-else i-tabler-eye-off op40 label="Hide" />
                  </div>
                  <template #content>
                    <span v-if="cell.value === 'highlight'">Highlight matching {{ noun }} links on results (does not hide).</span>
                    <span v-else-if="cell.value === 'invert'">Always show this {{ noun }} - even if matched by other filters.</span>
                    <span v-else>Hide works matching this {{ noun }}.</span>
                  </template>
                </Tooltip>
              </td>
            </template>
          </FiltersDataTable.Column>
          <FiltersDataTable.Column accessor="value">
            <template #cell="cell">
              <th scope="row">
                <div
                  text="start"
                  flex="~ items-center"
                  ws-nowrap
                >
                  <pre font="leading-[1em]" my-0.5 ws-pre-wrap>{{ cell.value }}</pre>
                  <Tooltip>
                    <div
                      flex="~ items-center justify-center"
                      mx-1 h-5 w-5 rounded-md
                    >
                      <Icon v-if="/^\d+$/.test(cell.value.trim())" i-codicon-symbol-numeric label="Id" />
                      <Icon v-else-if="cell.row.data.matcher === 'exact'" i-codicon-symbol-string label="Exact" />
                      <Icon v-else-if="cell.row.data.matcher === 'contains'" i-codicon-whole-word label="Contains" />
                      <Icon v-else-if="cell.row.data.matcher === 'regex'" i-codicon-regex label="Regex" />
                    </div>
                    <template #content>
                      <span v-if="/^\d+$/.test(cell.value.trim())">A numeric value matches the {{ noun }} id exactly.</span>
                      <span v-else-if="cell.row.data.matcher === 'exact'">Matches if the name exactly equals the filter. (default)</span>
                      <span v-else-if="cell.row.data.matcher === 'contains'">Matches if the name contains the filter text.</span>
                      <span v-else-if="cell.row.data.matcher === 'regex'">Uses a regular expression to match the name.</span>
                    </template>
                  </Tooltip>
                </div>
              </th>
            </template>
            <template #header>
              <th colspan="2">
                Name or id
              </th>
            </template>
          </FiltersDataTable.Column>
          <FiltersDataTable.Column id="actions">
            <template #cell="cell">
              <td w-2>
                <div mx-2 ws-nowrap>
                  <DialogDetachedTrigger
                    v-if="editDialog"
                    :id="`${cell.id}.edit`"
                    :dialog="editDialog"
                    class="input-ring"
                    text="4 muted-fg hover:default-fg"
                    :aria-labelledby="`${cell.id}.edit ${cell.row.cells.value?.id}`"
                    mr-1 cursor-pointer rounded-md
                    @click="edit(cell.row.data)"
                  >
                    <Icon i-codicon-edit label="Edit" />
                  </DialogDetachedTrigger>
                  <button
                    class="input-ring"
                    text="4 muted-fg hover:default-fg"
                    cursor-pointer rounded-md
                    @click="remove(cell.row.data)"
                  >
                    <Icon i-codicon-trash label="Remove" />
                  </button>
                </div>
              </td>
            </template>
            <template #header>
              <button
                class="btn"
                text="5 primary"
                h-6 w-6
                @click="edit()"
              >
                <Icon i-mdi-plus-box label="Add new filter" />
              </button>
            </template>
          </FiltersDataTable.Column>
        </FiltersDataTable>
      </div>
    </div>

    <label flex="~ items-center gap-3 justify-between" mt-3 text="sm">
      <span flex="~ col gap-0.5">
        <span>Default highlight color</span>
        <span text="xs muted-fg">Used by highlight &amp; force-shown (invert) {{ noun }} entries without an assigned color.</span>
      </span>
      <ColorInput v-model="defaultColorModel" />
    </label>

    <Dialog :ref="setDialogRef" v-model:open="open" detached-trigger>
      <DialogContent>
        <DialogTitle>
          {{ creating ? 'Create' : 'Edit' }} {{ noun }} filter
        </DialogTitle>
        <DialogDescription class="sr-only">
          Configure a {{ noun }} filter by name or id, and whether matching works are hidden, force-shown, or highlighted.
        </DialogDescription>
        <div flex="~ col gap-4" pt-4>
          <label flex="~ col gap-1">
            <span text="sm muted-fg">Name or id</span>
            <Input
              v-model="value"
              type="text"
              text="base" h-10 w-full py-2 pl-2 pr-15
            >
              <div absolute inset-y-0 right-2 flex="inline items-center">
                <RekaToggleGroupRoot
                  :model-value="matcher"
                  type="single"
                  :disabled="isNumericValue"
                  @update:model-value="(value) => matcher = (value ?? matcher) as EntityFilter['matcher']"
                >
                  <RekaToggleGroupItem
                    v-for="[v, label, tooltip, icon] in MatcherTypes"
                    :key="v"
                    :value="v"
                    h-6
                    w-6
                    cursor-pointer
                    rounded-md
                    border="1 transparent state-on:primary"
                    bg="hover:input state-on:primary! state-on:op30!"
                    :class="isNumericValue ? 'op40' : ''"
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
            <p text="xs muted-fg" pl-1>
              Enter the {{ noun }}'s title, or its numeric id (the number in its URL). A purely numeric value matches the
              {{ noun }} id exactly; otherwise the title is matched using the chosen matcher.
            </p>
          </label>

          <label flex="~ col gap-1">
            <span text="sm muted-fg">Behavior</span>
            <Select v-model="behavior" h-10 w-full>
              <SelectItem value="hide">
                Hide works matching this {{ noun }}
              </SelectItem>
              <SelectItem value="invert">
                Always show (even if hidden by another rule)
              </SelectItem>
              <SelectItem value="highlight">
                Highlight the {{ noun }} (does not hide)
              </SelectItem>
            </Select>
          </label>

          <label v-if="behavior === 'invert'" flex="~ items-center gap-2" text="sm">
            <input v-model="noHighlight" type="checkbox">
            <span text="muted-fg">No highlight (don't colour the matching {{ noun }} link)</span>
          </label>

          <label v-if="showColor" flex="~ col gap-1">
            <span text="sm muted-fg">Highlight color</span>
            <ColorInput v-model="color">
              <span text="xs muted-fg">Shown as a highlight behind the {{ noun }} link on results.</span>
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
  </OptionRowCollapsable>
</template>
