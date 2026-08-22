<script setup lang="ts">
import type { Rule } from '#common'

import { DEFAULT_BEHAVIOR_PRIORITY, rulePriority, ruleTargetColor, ruleTargetLabel } from '#common'

const RulesDataTable = useDataTable<Rule>()

const { filters, colors } = useOption('rules')

/**
 * Free-text filter over the rule *text* only — not the target, not the pseud.
 * A long rule list is searched for the tag you half-remember, and matching the
 * other columns would surface rules whose text has nothing to do with what you
 * typed. Case-insensitive "contains"; no wildcards, deliberately, so a typed
 * `*` or `.` finds a rule that literally has one.
 */
const query = ref('')
const needle = computed(() => query.value.trim().toLowerCase())

function matchesQuery(rule: Rule, text: string): boolean {
  return !text || rule.value.toLowerCase().includes(text)
}

/** How many rules the filter is showing, and how many there are in total. */
const shown = computed(() => filters.value.filter(rule => matchesQuery(rule, needle.value)).length)

/**
 * Click a header to sort by it: ascending, then descending, then off. "Off"
 * matters — the default grouping (by target, then value) is the one that puts
 * like rules together, and it is worth being able to get back to without
 * reloading the page.
 */
type SortKey = 'behavior' | 'priority' | 'value' | 'target'

/** Column id -> sort key. Anything absent (the actions column) isn't sortable. */
const SORT_KEYS: Record<string, SortKey> = {
  behavior: 'behavior',
  priority: 'priority',
  value: 'value',
  target: 'target',
}

/**
 * The order the Action column sorts in. Alphabetical would interleave the two
 * hiding behaviours with the two that don't hide anything; this is the order the
 * help text introduces them, strongest effect first.
 */
const BEHAVIOR_RANK: Record<string, number> = { hide: 0, invert: 1, highlight: 2, hideFilter: 3 }

const sortKey = ref<SortKey | null>(null)
const sortDir = ref<'asc' | 'desc'>('asc')

function sortKeyFor(columnId: string): SortKey | undefined {
  return SORT_KEYS[columnId]
}

function toggleSort(key: SortKey): void {
  if (sortKey.value !== key) {
    sortKey.value = key
    sortDir.value = 'asc'
  }
  else if (sortDir.value === 'asc') {
    sortDir.value = 'desc'
  }
  else {
    sortKey.value = null
  }
}

/** What a screen reader should hear about this column's current sort. */
function ariaSort(columnId: string): 'ascending' | 'descending' | 'none' | undefined {
  const key = sortKeyFor(columnId)
  if (!key)
    return undefined
  if (sortKey.value !== key)
    return 'none'
  return sortDir.value === 'asc' ? 'ascending' : 'descending'
}

/** Spell the next click out, since a three-way toggle isn't guessable. */
function sortHint(columnId: string): string {
  const key = sortKeyFor(columnId)
  if (!key)
    return ''
  if (sortKey.value !== key)
    return 'Sort ascending'
  return sortDir.value === 'asc' ? 'Sort descending' : 'Clear sort'
}

function compareBy(a: Rule, b: Rule, key: SortKey): number {
  switch (key) {
    case 'behavior':
      return (BEHAVIOR_RANK[a.behavior ?? 'hide'] ?? 0) - (BEHAVIOR_RANK[b.behavior ?? 'hide'] ?? 0)
    case 'priority':
      return rulePriority(a) - rulePriority(b)
    case 'value':
      return a.value.localeCompare(b.value, undefined, { sensitivity: 'base' })
    case 'target':
      // By the label, not the raw target, so the order matches the column. The
      // fallback is not decoration: `ruleTargetLabel` returns undefined for a
      // target it doesn't know, which an old export or a hand-edited import can
      // still carry, and sorting must not be what takes the options page down.
      return (ruleTargetLabel(a.target) ?? '').localeCompare(ruleTargetLabel(b.target) ?? '')
  }
}

/** Group by what a rule targets, then by value, so like rules sit together. */
function renderData(rules: Rule[]) {
  const rows = rules
    // Filter *after* mapping: the index is the rule's position in the stored
    // list, which is what the table keys rows by. Filtering first would renumber
    // them against a list that no longer matches storage.
    .map((rule, index) => [index, rule] as [number, Rule])
    .filter(([_i, rule]) => matchesQuery(rule, needle.value))

  const key = sortKey.value
  if (!key)
    return rows.sort(([_ai, a], [_bi, b]) => a.target.localeCompare(b.target) || a.value.localeCompare(b.value))

  const dir = sortDir.value === 'desc' ? -1 : 1
  // Every key but `value` has heavy ties, so the rule text breaks them — and it
  // stays ascending whichever way the column is pointing, so the rows inside a
  // group don't shuffle when you reverse the sort.
  return rows.sort(([_ai, a], [_bi, b]) =>
    dir * compareBy(a, b, key) || a.value.localeCompare(b.value, undefined, { sensitivity: 'base' }))
}

/** The colour a highlight star should show for a rule (its own, else its target's). */
function starColor(rule: Rule): string {
  return rule.color || ruleTargetColor(rule.target, colors.value)
}

/** A priority worth showing: anything the behaviour wouldn't have given it anyway. */
function isCustomPriority(rule: Rule): boolean {
  return rulePriority(rule) !== DEFAULT_BEHAVIOR_PRIORITY[rule.behavior ?? 'hide']
}

const context = OptionRowRulesContext.inject()
</script>

<template>
  <div flex="~ items-center gap-2" mt-4>
    <Input
      v-model="query"
      type="text"
      placeholder="Search rules…"
      aria-label="Search rules by text"
      autocomplete="off"
      spellcheck="false"
      text="sm" h-8 w-full py-1 pl-2
    >
      <button
        v-if="query"
        class="input-ring"
        text="4 muted-fg hover:default-fg"
        absolute inset-y-0 right-1 my-auto h-5 w-5 cursor-pointer rounded-md
        aria-label="Clear rule search"
        @click="query = ''"
      >
        <Icon i-codicon-close label="Clear" />
      </button>
    </Input>
    <span v-if="needle" text="xs muted-fg" ws-nowrap>
      {{ shown }} of {{ filters.length }}
    </span>
  </div>

  <div mx="-4" relative mt-2>
    <div mx="sm:4" max-h-96 overflow-auto border rounded-md bg-default>
      <RulesDataTable
        id="rules-filters"
        :data="filters"
        :render-data="renderData"
        text="sm"
        w-full
        class="[&_td,&_th]:h-7 [&_td,&_th]:min-h-7 [&_td,&_th]:align-middle"
      >
        <template #header="{ inner, header }">
          <th
            scope="col" sticky top-0 z-10 bg-default text-muted-fg font-medium
            :aria-sort="ariaSort(header.column.props.id)"
          >
            <div flex="~ items-center justify-center " h-8 border-b>
              <button
                v-if="sortKeyFor(header.column.props.id)"
                type="button"
                class="input-ring"
                flex="~ items-center justify-center gap-0.5"
                h-6 w-full cursor-pointer rounded-md px-1
                :title="sortHint(header.column.props.id)"
                @click="toggleSort(sortKeyFor(header.column.props.id)!)"
              >
                <Render :render="inner" />
                <!-- Written out rather than a bound class: UnoCSS only ships the
                     icons it can see spelled out in a template. -->
                <Icon
                  v-if="sortKey === sortKeyFor(header.column.props.id) && sortDir === 'asc'"
                  i-mdi-arrow-up text="3" label="sorted ascending"
                />
                <Icon
                  v-else-if="sortKey === sortKeyFor(header.column.props.id)"
                  i-mdi-arrow-down text="3" label="sorted descending"
                />
              </button>
              <Render v-else :render="inner" />
            </div>
          </th>
        </template>
        <template #row="{ inner, row }">
          <tr
            bg="hover:muted/50"
            transition-colors
            class="[&:not(:last-child)]:border-b"
            @dblclick="context.edit?.(row.data)"
          >
            <Render :render="inner" />
          </tr>
        </template>
        <RulesDataTable.Column accessor="behavior">
          <template #header>
            <th w-1>
              <Icon i-mdi-lightning-bolt text="3.5" label="Action" />
            </th>
          </template>
          <template #cell="cell">
            <td w-1>
              <Tooltip>
                <div flex="~ items-center justify-center" h-full px-2 text="4">
                  <Icon
                    v-if="cell.value === 'highlight'"
                    i-mdi-star
                    :style="{ color: starColor(cell.row.data) }"
                    label="Highlight"
                  />
                  <Icon v-else-if="cell.value === 'invert'" i-tabler-eye-exclamation op100 label="Show" />
                  <Icon v-else-if="cell.value === 'hideFilter'" i-mdi-tag-off op100 label="Hide tag" />
                  <Icon v-else i-tabler-eye-off op40 label="Hide" />
                </div>
                <template #content>
                  <span v-if="cell.value === 'highlight'">Highlight the match on results (does not hide).</span>
                  <span v-else-if="cell.value === 'invert'">Always show matching works - unless a hide rule outranks this one.</span>
                  <span v-else-if="cell.value === 'hideFilter'">Hide the matching tags themselves, on works and in the filter sidebar (does not hide works).</span>
                  <span v-else>Hide matching works.</span>
                </template>
              </Tooltip>
            </td>
          </template>
        </RulesDataTable.Column>
        <RulesDataTable.Column accessor="priority" header="Pri">
          <template #cell="cell">
            <td w-1>
              <Tooltip>
                <div
                  flex="~ items-center justify-center" h-full px-1
                  text="xs center"
                  :class="isCustomPriority(cell.row.data) ? 'font-medium' : 'text-muted-fg op60'"
                >
                  {{ rulePriority(cell.row.data) }}
                </div>
                <template #content>
                  <span>
                    Priority {{ rulePriority(cell.row.data) }} of 9.
                    The highest-priority rule matching a work decides whether it is hidden; ties go to "always show".
                  </span>
                </template>
              </Tooltip>
            </td>
          </template>
        </RulesDataTable.Column>
        <RulesDataTable.Column accessor="value">
          <template #cell="cell">
            <th scope="row">
              <div
                text="start"
                flex="~ items-center"
                ws-nowrap
              >
                <pre font="leading-[1em]" my-0.5 ws-pre-wrap>{{ cell.value }}<span v-if="cell.row.data.pseud" text="muted-fg">&nbsp;({{ cell.row.data.pseud }})</span></pre>
                <Tooltip>
                  <div
                    flex="~ items-center justify-center"
                    mx-1 h-5 w-5 rounded-md
                  >
                    <Icon
                      v-if="(cell.row.data.target === 'work' || cell.row.data.target === 'series') && /^\d+$/.test(cell.value.trim())"
                      i-codicon-symbol-numeric
                      label="Id"
                    />
                    <Icon v-else-if="cell.row.data.matcher === 'exact'" i-codicon-symbol-string label="Exact" />
                    <Icon v-else-if="cell.row.data.matcher === 'contains'" i-codicon-whole-word label="Contains" />
                    <Icon v-else-if="cell.row.data.matcher === 'regex'" i-codicon-regex label="Regex" />
                  </div>
                  <template #content>
                    <span v-if="(cell.row.data.target === 'work' || cell.row.data.target === 'series') && /^\d+$/.test(cell.value.trim())">A numeric value matches the id exactly.</span>
                    <span v-else-if="cell.row.data.matcher === 'exact'">Matches if the value exactly equals the rule. (default)</span>
                    <span v-else-if="cell.row.data.matcher === 'contains'">Matches if the value contains the rule. Often used for matching one person in a Relationship tag.</span>
                    <span v-else-if="cell.row.data.matcher === 'regex'">Uses regular expressions to match the rule to the value.</span>
                  </template>
                </Tooltip>
              </div>
            </th>
          </template>
          <template #header>
            <th>
              Rule
            </th>
          </template>
        </RulesDataTable.Column>
        <RulesDataTable.Column accessor="target" header="Applies to">
          <template #cell="cell">
            <div text="xs tracking-tight center">
              <span ws-nowrap>{{ ruleTargetLabel(cell.value) }}</span>
            </div>
          </template>
        </RulesDataTable.Column>
        <RulesDataTable.Column id="actions">
          <template #cell="cell">
            <td w-2>
              <div mx-2 ws-nowrap>
                <DialogDetachedTrigger
                  v-if="context.editDialog.value"
                  :id="`${cell.id}.edit`"
                  :dialog="context.editDialog.value"
                  class="input-ring"
                  text="4 muted-fg hover:default-fg"
                  :aria-labelledby="`${cell.id}.edit ${cell.row.cells.value?.id}`"
                  mr-1 cursor-pointer rounded-md
                  @click="context.edit?.(cell.row.data)"
                >
                  <Icon i-codicon-edit label="Edit" />
                </DialogDetachedTrigger>
                <button
                  class="input-ring"
                  text="4 muted-fg hover:default-fg"
                  cursor-pointer rounded-md
                  @click="context.remove?.(cell.row.data)"
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
              @click="context.edit?.()"
            >
              <Icon i-mdi-plus-box label="Add new rule" />
            </button>
          </template>
        </RulesDataTable.Column>
      </RulesDataTable>
      <p v-if="needle && shown === 0" text="sm center muted-fg" py-6>
        No rules match “{{ query.trim() }}”.
      </p>
    </div>
  </div>
</template>
