<script setup lang="ts">
const { enabled, tools, rules } = useOption('textReplacements')

function add() {
  rules.value.push({ find: '', replace: '', caseSensitive: false, matchCasing: false, wholeWord: false, disabled: false })
}

function remove(index: number) {
  rules.value.splice(index, 1)
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Text replacement"
    subtitle="Find and replace text in a work’s summary, notes and chapters as you read — for renaming a character or fixing a tic. Only what is displayed changes. Includes optional tools on the works page for adding and editing replacements as you read."
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
          <span font="leading-none 400" text="base">Works page Text Replacement tools</span>
          <span text="sm muted-fg">
            On a work, underline the text your rules replaced — click one to edit, disable or delete that rule —
            and offer a button beside any text you select to make a new rule out of it. Can also be switched on and
            off from the extension’s floating toolbar while you read.
          </span>
        </div>
        <Switch id="ao3e-text-replacement-tools" v-model="tools" />
      </label>

      <p v-if="rules.length === 0" text="sm muted-fg">
        No replacements yet. Add one to rewrite words in the body of works you read.
      </p>

      <div
        v-for="(rule, index) in rules"
        :key="index"
        :class="rule.disabled ? 'op-60' : ''"
        flex="~ col gap-2"
        border rounded-md p-3
      >
        <div flex="~ gap-2 items-center wrap">
          <Input
            v-model="rule.find"
            type="text"
            placeholder="Find"
            text="base" h-9 min-w-40 flex-1 py-2 pl-2
          />
          <Icon i-mdi-arrow-right shrink-0 text="muted-fg" />
          <Input
            v-model="rule.replace"
            type="text"
            placeholder="Replace with"
            text="base" h-9 min-w-40 flex-1 py-2 pl-2
          />
          <button
            class="input-ring"
            text="4 muted-fg hover:default-fg"
            shrink-0 cursor-pointer rounded-md p-1
            title="Remove this replacement"
            @click="remove(index)"
          >
            <Icon i-codicon-trash label="Remove" />
          </button>
        </div>
        <div flex="~ gap-4 items-center wrap" pl-1 text="sm muted-fg">
          <label flex="~ gap-1.5 items-center">
            <input v-model="rule.caseSensitive" type="checkbox">
            <span>Case sensitive</span>
          </label>
          <label flex="~ gap-1.5 items-center" :class="rule.caseSensitive ? 'op50' : ''">
            <input v-model="rule.matchCasing" type="checkbox" :disabled="rule.caseSensitive">
            <span>Match casing</span>
          </label>
          <label flex="~ gap-1.5 items-center">
            <input v-model="rule.wholeWord" type="checkbox">
            <span>Whole word</span>
          </label>
          <!-- Apart from the three that shape the match, because it is the only
               one that decides whether the rule runs at all. -->
          <label flex="~ gap-1.5 items-center" ml-auto title="Keep the rule but stop it applying.">
            <input v-model="rule.disabled" type="checkbox">
            <span>Disabled</span>
          </label>
        </div>
      </div>

      <p text="xs muted-fg" pl-1>
        "Match casing" matches any casing and, when a match starts with a capital letter, capitalises the
        replacement to match — so one rule covers both lowercase and capitalised forms. "Disabled" keeps a rule
        in the list without applying it, for a replacement you want back later or one of several variants.
      </p>

      <div>
        <Button variant="outline" text="sm" @click="add">
          <Icon i-mdi-plus mr-1 label="Add" /> Add replacement
        </Button>
      </div>
    </div>
  </OptionRowCollapsable>
</template>
