<script setup lang="ts">
import { MATCH_CASING_OFF, matchCasingOff } from '../../model/textReplacements.ts'

const { enabled, tools, rules } = useOption('textReplacements')

/**
 * Each row is find → replace, the rule's five flags as toggles, and Remove. In
 * a narrow frame the toggles and Remove take a line of their own under the pair.
 */
const ROW = '"identity actions" / minmax(0, 1fr) auto'
const NARROW_ROW = '"identity" "actions" / minmax(0, 1fr)'

const casingOffId = useId()

const frame = useTemplateRef('frame')

async function add() {
  rules.value.push({
    find: '',
    replace: '',
    caseSensitive: false,
    matchCasing: false,
    wholeWord: false,
    acrossFormatting: false,
    disabled: false,
  })
  await nextTick()
  frame.value?.reveal(rules.value.length - 1)
}

function remove(index: number) {
  rules.value.splice(index, 1)
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Text replacement"
    subtitle="Find and replace text in a work’s summary, notes and chapters as you read — for renaming a character or fixing a tic. Only what is displayed changes; the work itself is untouched."
  >
    <div flex="~ col gap-3" pt-2>
      <!-- Laid out the way `OptionRow` lays a setting out — label left, control
           hard right — so it reads as one of the page's settings rather than as
           part of the list of rules below it. Not an `OptionRow` itself: that
           would enter it in the settings search as a row of its own, and a query
           matching it but not its parent would hide the parent and take this
           with it. -->
      <label
        for="ao3e-text-replacement-tools"
        grid="~ cols-[1fr_min-content] items-center"
        cursor-pointer py-1
      >
        <div flex="~ col" mr-4>
          <span text="[13.5px]" leading="[18px]">Editing tools on the work page</span>
          <span text="[12px] muted-fg" leading="[17px]">
            Underline the text your rules replaced — click one to edit, disable or delete its rule — and offer a
            button beside any text you select to make a new rule out of it. Also on the floating toolbar.
          </span>
        </div>
        <Switch id="ao3e-text-replacement-tools" v-model="tools" />
      </label>

      <ListFrame
        ref="frame"
        list-id="text-replacements"
        title="Text replacements"
        :count="rules.length ? String(rules.length) : 'none yet'"
        :empty="rules.length === 0"
        add-label="Add a replacement"
        @add="add"
      >
        <template #empty>
          <b>No replacements yet</b>
          Add one to rewrite words in the body of works you read.
        </template>

        <ListRow
          v-for="(rule, index) in rules"
          :key="index"
          :row-id="index"
          :template="ROW"
          :narrow-template="NARROW_ROW"
          :off="rule.disabled"
        >
          <div class="grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] items-center gap-2">
            <Input
              v-model="rule.find"
              type="text"
              placeholder="Find"
              aria-label="Find"
              class="h-[22px] w-full px-[7px] text-[12.5px]"
            />
            <span class="i-tabler-arrow-right justify-self-center text-[13px] text-muted-fg" aria-hidden="true" />
            <Input
              v-model="rule.replace"
              type="text"
              placeholder="Replace with"
              aria-label="Replace with"
              class="h-[22px] w-full px-[7px] text-[12.5px]"
            />
          </div>
          <template #actions>
            <div class="flex items-center gap-2">
              <div class="flex gap-[2px]">
                <IconToggle v-model="rule.caseSensitive" label="Case sensitive" icon="i-codicon-case-sensitive" />
                <IconToggle
                  v-model="rule.matchCasing"
                  label="Match casing"
                  icon="i-codicon-preserve-case"
                  :tip="matchCasingOff(rule) ?? undefined"
                  :disabled="!!matchCasingOff(rule)"
                  :aria-describedby="matchCasingOff(rule) ? casingOffId : undefined"
                />
                <IconToggle v-model="rule.wholeWord" label="Whole word" icon="i-codicon-whole-word" />
                <IconToggle
                  v-model="rule.acrossFormatting"
                  label="Match across formatting"
                  tip="Across formatting"
                  icon="i-tabler-code"
                />
                <IconToggle v-model="rule.disabled" label="Disable this replacement" tip="Disabled" icon="i-tabler-ban" />
              </div>
              <button
                type="button"
                class="icon-btn"
                aria-label="Remove replacement"
                title="Remove replacement"
                @click="remove(index)"
              >
                <span class="i-tabler-trash" text="sm" aria-hidden="true" />
              </button>
            </div>
          </template>
        </ListRow>
      </ListFrame>
      <span :id="casingOffId" hidden>{{ MATCH_CASING_OFF }}</span>

      <p text="[11.5px] muted-fg" leading="[16px]">
        "Match casing" matches any casing and capitalises the replacement when the match was capitalised, so one rule
        covers both forms. "Across formatting" matches through italics, links and the like, where the words are split
        across markup; the replacement takes the formatting of wherever the match started. "Disabled" keeps a rule
        without applying it.
      </p>
    </div>
  </OptionRowCollapsable>
</template>
