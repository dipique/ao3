<script setup lang="ts">
import type { RuleTarget } from '#common'

import { DEFAULT_RULE_COLORS, RULE_TARGETS, ruleTargetLabel } from '#common'

/**
 * The default highlight colour for every rule target. These are what a rule
 * inherits when it sets no colour of its own, so they're one table rather than a
 * setting per list — which is what they were before tags, authors, works and
 * series became one Rules list.
 */
const { colors } = useOption('rules')

/** A colour model per target: reads the override or the built-in, writes the override. */
function model(target: RuleTarget) {
  return computed({
    get: () => colors.value[target] || DEFAULT_RULE_COLORS[target],
    // Setting it back to the built-in stores nothing, so the target keeps
    // tracking the default if it ever changes.
    set: (v: string) => {
      if (v === DEFAULT_RULE_COLORS[target])
        delete colors.value[target]
      else
        colors.value[target] = v
    },
  })
}

const rows = RULE_TARGETS.map(target => ({ target, label: ruleTargetLabel(target), color: model(target) }))

const customCount = computed(() =>
  RULE_TARGETS.filter(t => colors.value[t] && colors.value[t] !== DEFAULT_RULE_COLORS[t]).length)

function resetAll() {
  for (const target of RULE_TARGETS)
    delete colors.value[target]
}
</script>

<template>
  <Dialog>
    <DialogTrigger as-child>
      <Button variant="outline" size="sm">
        Default highlight colors<span v-if="customCount" text="xs muted-fg">&nbsp;({{ customCount }} changed)</span>
      </Button>
    </DialogTrigger>
    <DialogContent>
      <DialogTitle>
        Default highlight colors
      </DialogTitle>
      <DialogDescription class="sr-only">
        Set the highlight colour each kind of rule uses when it has no colour of its own.
      </DialogDescription>
      <div flex="~ col gap-3" pt-4>
        <p text="sm muted-fg">
          Used by highlight and force-shown ("always show") rules that don't set a colour of their own. A rule picks up
          the colour for whatever it applies to, so changing one here re-colours every rule still inheriting it.
        </p>
        <div max-h-96 flex="~ col gap-2" overflow-auto>
          <label
            v-for="row in rows"
            :key="row.target"
            flex="~ items-center gap-3 justify-between"
            text="sm"
          >
            <span>{{ row.label }}</span>
            <ColorInput v-model="row.color.value" />
          </label>
        </div>
        <div flex="~ gap-4 justify-end">
          <Button
            text="sm"
            variant="outline"
            :disabled="customCount === 0"
            @click="resetAll"
          >
            Reset all
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
