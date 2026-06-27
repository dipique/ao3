<script setup lang="ts">
const { enabled, rules } = useOption('textReplacements')

function add() {
  rules.value.push({ find: '', replace: '', caseSensitive: false, matchCasing: false, wholeWord: false })
}

function remove(index: number) {
  rules.value.splice(index, 1)
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Text replacement"
    subtitle="Find and replace words in the text of works you read"
  >
    <div flex="~ col gap-3" pt-2>
      <p v-if="rules.length === 0" text="sm muted-fg">
        No replacements yet. Add one to rewrite words in the body of works you read.
      </p>

      <div
        v-for="(rule, index) in rules"
        :key="index"
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
        </div>
      </div>

      <p text="xs muted-fg" pl-1>
        "Match casing" matches any casing and, when a match starts with a capital letter, capitalises the
        replacement to match — so one rule covers both lowercase and capitalised forms.
      </p>

      <div>
        <Button variant="outline" text="sm" @click="add">
          <Icon i-mdi-plus mr-1 label="Add" /> Add replacement
        </Button>
      </div>
    </div>
  </OptionRowCollapsable>
</template>
