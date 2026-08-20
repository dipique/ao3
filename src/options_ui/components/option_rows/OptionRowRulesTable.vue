<script setup lang="ts">
import type { Rule } from '#common'

import { DEFAULT_BEHAVIOR_PRIORITY, rulePriority, ruleTargetColor, ruleTargetLabel } from '#common'

const RulesDataTable = useDataTable<Rule>()

const { filters, colors } = useOption('rules')

/** Group by what a rule targets, then by value, so like rules sit together. */
function renderData(rules: Rule[]) {
  return rules
    .map((rule, index) => [index, rule] as [number, Rule])
    .sort(([_ai, a], [_bi, b]) =>
      a.target.localeCompare(b.target) || a.value.localeCompare(b.value))
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
  <div mx="-4" relative mt-4>
    <div mx="sm:4" max-h-96 overflow-auto border rounded-md bg-default>
      <RulesDataTable
        id="rules-filters"
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
            @dblclick="context.edit?.(row.data)"
          >
            <Render :render="inner" />
          </tr>
        </template>
        <RulesDataTable.Column accessor="behavior">
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
            <th colspan="2">
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
    </div>
  </div>
</template>
