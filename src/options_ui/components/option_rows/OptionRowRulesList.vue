<script setup lang="ts">
import type { Rule } from '#common'

import { matchesById, ruleTargetColor, ruleTargetLabel } from '#common'

import type { KeySort, RuleSortKey } from '../../model/listView.ts'

import { heldOrderStale, holdWithout, RULE_SORTS, rulePriorityCell, shownRules, UNSORTED } from '../../model/listView.ts'

const { filters, colors } = useOption('rules')
const defaults = useRulePriorityDefaults()

const context = OptionRowRulesContext.inject()

/**
 * The filter and the sort only change what the list shows, and last for the
 * visit: neither writes the rules.
 *
 * Opening a rule to edit it holds the order the rows are in, so working down
 * the list, each rule edited stays in its row rather than moving to where it
 * sorts now. Re-sort lets go of it, and so does changing the filter or the
 * sort.
 */
const query = ref('')
const sort = ref<KeySort<RuleSortKey>>(UNSORTED)
const hold = ref<number[] | null>(null)
watch([query, sort], () => {
  hold.value = null
})

const shown = computed(() => shownRules(filters.value, query.value, sort.value, defaults.value, hold.value).map((at) => {
  const rule = filters.value[at]!
  return { at, rule, priority: rulePriorityCell(rule, defaults.value) }
}))
const stale = computed(() => heldOrderStale(filters.value, query.value, sort.value, defaults.value, hold.value))

/**
 * A list of hundreds of rules is drawn a window at a time: the frame says
 * which of the shown rules to draw, by their places among them, and each
 * drawn row says where it stands in the whole list.
 */
const keys = computed(() => shown.value.map(row => row.at))
function drawn(places: readonly number[] = []) {
  return places.map(place => ({ ...shown.value[place]!, place: place + 1 }))
}

function edit(rule: Rule) {
  hold.value ??= shown.value.map(row => row.at)
  context.edit?.(rule)
}

function remove(at: number, rule: Rule) {
  context.remove?.(rule)
  hold.value = holdWithout(hold.value, at)
}

const count = computed(() => {
  if (query.value.trim())
    return `${shown.value.length} of ${filters.value.length}`
  const total = filters.value.length
  return total ? `${total} ${total === 1 ? 'rule' : 'rules'}` : 'none yet'
})

/**
 * Each row is the rule's action, its priority, its text with its matcher (and
 * an author's pseud), what it applies to, then Edit and Remove. In a narrow
 * frame what it applies to goes under the text.
 */
const ROW = '"icon numbers identity meta actions" / 26px 22px minmax(0, 1fr) minmax(0, 104px) auto'
const NARROW_ROW = '"icon numbers identity actions" "icon numbers meta actions" / 22px 18px minmax(0, 1fr) auto'

/** The colour a highlight star shows for a rule: its own, else its target's. */
function starColor(rule: Rule): string {
  return rule.color || ruleTargetColor(rule.target, colors.value)
}

/**
 * Add, from the frame's header. The dialog gives focus back to whatever had it
 * when it opened, so the button takes focus first, as a click doesn't make it
 * do in every browser.
 */
function add(event: MouseEvent) {
  (event.currentTarget as HTMLElement).focus()
  context.edit?.()
}
</script>

<template>
  <ListFrame
    list-id="rules"
    title="Rules"
    :count="count"
    :empty="shown.length === 0"
    add-label="Add a rule"
    expandable
    :virtual-rows="keys"
    @add="add"
  >
    <template #filter>
      <ListFilter v-model="query" label="Search rules by text" placeholder="Search rules" clear-label="Clear rule search" />
    </template>
    <template #controls>
      <button
        v-if="stale"
        type="button"
        class="rules-resort input-ring"
        title="Put the rows in sorted order again"
        data-action="resort"
        @click="hold = null"
      >
        <span class="i-tabler-arrows-sort text-[13px]" aria-hidden="true" />
        Re-sort
      </button>
      <ListKeySort v-model="sort" :choices="RULE_SORTS" />
    </template>
    <template #empty>
      <template v-if="filters.length">
        No rules match “{{ query.trim() }}”.
      </template>
      <template v-else>
        <b>No rules yet</b>
        Add one to hide, collapse, always show or highlight works.
      </template>
    </template>

    <template #default="{ rows }">
      <ListRow
        v-for="{ at, rule, priority, place } in drawn(rows)"
        :key="at"
        :row-id="at"
        :aria-posinset="place"
        :aria-setsize="shown.length"
        :template="ROW"
        :narrow-template="NARROW_ROW"
        :off="rule.behavior === 'none'"
        @dblclick="edit(rule)"
      >
        <template #icon>
          <Tooltip>
            <span class="grid place-items-center text-[15px]">
              <Icon v-if="rule.behavior === 'highlight'" i-mdi-star :style="{ color: starColor(rule) }" label="Highlight" />
              <Icon v-else-if="rule.behavior === 'collapse'" i-mdi-arrow-collapse-vertical label="Collapse" />
              <Icon v-else-if="rule.behavior === 'invert'" i-tabler-eye-exclamation class="text-brand-fg" label="Always show" />
              <Icon v-else-if="rule.behavior === 'hideFilter'" i-mdi-tag-off label="Hide tag" />
              <Icon v-else-if="rule.behavior === 'none'" i-mdi-cancel label="Disabled rule" />
              <Icon v-else i-tabler-eye-off label="Hide work" />
            </span>
            <template #content>
              <span v-if="rule.behavior === 'highlight'">Highlight the match on results (does not hide).</span>
              <span v-else-if="rule.behavior === 'collapse'">Collapse matching works to a line saying why, with a button to show them.</span>
              <span v-else-if="rule.behavior === 'invert'">Always show matching works - unless a hide rule outranks this one.</span>
              <span v-else-if="rule.behavior === 'hideFilter'">Hide the matching tags themselves, on works and in the filter sidebar (does not hide works).</span>
              <span v-else-if="rule.behavior === 'none'">Disabled - the rule is kept, but does nothing at all.</span>
              <span v-else>Hide matching works completely - they leave the listing.</span>
            </template>
          </Tooltip>
        </template>
        <template #numbers>
          <Tooltip :content="priority.title">
            <span :class="priority.custom ? 'font-700 text-default-fg' : ''">
              <span aria-hidden="true">{{ priority.text }}</span>
              <span class="sr-only">{{ priority.title }}</span>
            </span>
          </Tooltip>
        </template>
        <span class="min-w-0 flex items-center gap-[7px]">
          <span class="overflow-hidden text-ellipsis whitespace-pre" :title="rule.value">{{ rule.value }}<span v-if="rule.pseud" class="text-muted-fg"> ({{ rule.pseud }})</span></span>
          <Tooltip>
            <span class="list-row__glyph grid shrink-0 place-items-center text-[13px] text-muted-fg">
              <Icon v-if="matchesById(rule.target, rule.value)" i-codicon-symbol-numeric label="Id" />
              <Icon v-else-if="rule.matcher === 'contains'" i-codicon-whole-word label="Contains" />
              <Icon v-else-if="rule.matcher === 'regex'" i-codicon-regex label="Regex" />
              <Icon v-else i-codicon-symbol-string label="Exact" />
            </span>
            <template #content>
              <span v-if="matchesById(rule.target, rule.value)">A numeric value matches the id exactly.</span>
              <span v-else-if="rule.matcher === 'contains'">Matches if the value contains the rule. Often used for matching one person in a Relationship tag.</span>
              <span v-else-if="rule.matcher === 'regex'">Uses regular expressions to match the rule to the value.</span>
              <span v-else>Matches if the value exactly equals the rule. (default)</span>
            </template>
          </Tooltip>
        </span>
        <template #meta>
          {{ ruleTargetLabel(rule.target) }}
        </template>
        <template #actions>
          <DialogDetachedTrigger
            v-if="context.editDialog.value"
            :dialog="context.editDialog.value"
            class="icon-btn"
            :aria-label="`Edit rule “${rule.value}”`"
            title="Edit rule"
            data-action="edit"
            @click="edit(rule)"
          >
            <span class="i-tabler-pencil" text="[14px]" aria-hidden="true" />
          </DialogDetachedTrigger>
          <button
            type="button"
            class="icon-btn"
            :aria-label="`Remove rule “${rule.value}”`"
            title="Remove rule"
            data-action="remove"
            @click="remove(at, rule)"
          >
            <span class="i-tabler-trash" text="[14px]" aria-hidden="true" />
          </button>
        </template>
      </ListRow>
    </template>
  </ListFrame>
</template>

<style scoped>
/* The header's words' colour, in a pill as tall as its glyph buttons, since it
   shows only while the order is out of date and should be seen. */
.rules-resort {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid rgb(var(--color-border));
  border-radius: 999px;
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-default-fg));
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}
.rules-resort:hover {
  background-color: var(--row-hover);
}
</style>
