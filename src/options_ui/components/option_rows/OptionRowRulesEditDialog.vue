<script setup lang="ts">
import type { ComponentInstance, GlobalComponents } from 'vue'

import type { FilterBehavior, Rule, RuleTarget } from '#common'

import { DEFAULT_BEHAVIOR_PRIORITY, isTagTarget, MAX_PRIORITY, MIN_PRIORITY, RULE_TARGETS, rulePriority, ruleTargetColor, ruleTargetLabel } from '#common'

const context = OptionRowRulesContext.inject()
const { filters, colors } = useOption('rules')

const open = ref(false)

const MatcherTypes = [
  ['exact', 'Exact', 'Matches if the value exactly equals the rule. (default)', 'i-codicon-symbol-string'],
  ['contains', 'Contains', 'Matches if the value contains the rule. Often used for matching one person in a Relationship tag.', 'i-codicon-whole-word'],
  ['regex', 'Regex', 'Uses regular expressions to match the rule to the value.', 'i-codicon-regex'],
] as const

const Blank: Rule = {
  target: 'tag',
  value: '',
  matcher: 'exact',
}

const initial = ref(Blank)
const target = ref<RuleTarget>(Blank.target)
const value = ref(Blank.value)
// Kept as a plain string (never undefined) so the text Input's model type fits;
// an empty string is normalised back to `undefined` on save.
const pseud = ref('')
const matcher = ref<Rule['matcher']>(Blank.matcher)
const behavior = ref<FilterBehavior>('hide')
const priority = ref(DEFAULT_BEHAVIOR_PRIORITY.hide)
const color = ref('')
// Invert rules highlight by default; this opts out (stored as a 'transparent' colour).
const noHighlight = ref(false)

const creating = computed(() => toRaw(initial.value) === Blank)

/** The default highlight colour for whatever this rule currently targets. */
const resolvedDefault = computed(() => ruleTargetColor(target.value, colors.value))

const isAuthor = computed(() => target.value === 'author')
const isEntity = computed(() => target.value === 'work' || target.value === 'series')
const isNumericValue = computed(() => isEntity.value && /^\d+$/.test(value.value.trim()))

// "Hide the tag itself" only means anything for a tag — there is no author or
// work link to take out of a tag list.
const canHideFilter = computed(() => isTagTarget(target.value))

// The colour picker is shown whenever the rule will highlight: any highlight
// rule, or an invert rule that hasn't opted out via "No highlight".
const showColor = computed(() =>
  behavior.value === 'highlight' || (behavior.value === 'invert' && !noHighlight.value))

/** The priority this behaviour hands out on its own, shown as the hint under the field. */
const behaviorDefaultPriority = computed(() => DEFAULT_BEHAVIOR_PRIORITY[behavior.value])

// Choosing a behaviour sets the priority that behaviour implies; typing over it
// afterwards is what "manually overridden" means. Only 'invert' starts above 0,
// which is what makes "always show" win by default.
watch(behavior, (next, previous) => {
  if (next === previous)
    return
  // Disabling a rule is meant to keep it exactly as it was, so that turning it
  // back on restores what you had — priority included. Neither direction of the
  // 'none' switch touches it.
  if (next === 'none' || previous === 'none')
    return
  priority.value = DEFAULT_BEHAVIOR_PRIORITY[next]
})

// A behaviour that stops applying when the target changes falls back to hiding.
watch(target, () => {
  if (behavior.value === 'hideFilter' && !canHideFilter.value)
    behavior.value = 'hide'
  if (!isAuthor.value)
    pseud.value = ''
})

context.edit = (rule?: Rule) => {
  open.value = true
  initial.value = rule ?? toRaw(Blank)
  target.value = initial.value.target
  value.value = initial.value.value
  pseud.value = initial.value.pseud ?? ''
  matcher.value = initial.value.matcher
  behavior.value = initial.value.behavior ?? 'hide'
  priority.value = rulePriority(initial.value)
  // The 'transparent' sentinel is only ever written by an invert rule opting out
  // of its highlight, so reading it without checking the behaviour costs nothing
  // — and lets a *disabled* invert rule remember the opt-out until it's back on.
  noHighlight.value = initial.value.color === 'transparent'
  color.value = initial.value.color && initial.value.color !== 'transparent'
    ? initial.value.color
    : resolvedDefault.value
}

context.remove = (rule: Rule) => {
  filters.value.splice(filters.value.indexOf(rule), 1)
}

function setDialogRef(ref: unknown) {
  context.editDialog.value = ref as ComponentInstance<GlobalComponents['Dialog']>
}

function save() {
  // Store the defaults as missing: 'hide' behaviour, the behaviour's own
  // priority, and a colour that just matches the target's default (so the rule
  // keeps inheriting it, and tracks future changes to that default). For invert,
  // "No highlight" persists as the sentinel 'transparent'.
  const behaviorValue = behavior.value === 'hide' ? undefined : behavior.value
  const priorityValue = priority.value === behaviorDefaultPriority.value ? undefined : priority.value
  const colorValue
    // Disabling keeps the rule whole: the colour it will highlight in again once
    // re-enabled survives, even though the picker is hidden while it's off.
    = behavior.value === 'none'
      ? initial.value.color
      : behavior.value === 'invert' && noHighlight.value
        ? 'transparent'
        : showColor.value && color.value !== resolvedDefault.value
          ? color.value
          : undefined
  const pseudValue = isAuthor.value ? (pseud.value || undefined) : undefined

  if (creating.value) {
    filters.value.push({
      target: target.value,
      value: value.value,
      pseud: pseudValue,
      matcher: matcher.value,
      behavior: behaviorValue,
      priority: priorityValue,
      color: colorValue,
    })
  }
  else {
    initial.value.target = target.value
    initial.value.value = value.value
    initial.value.pseud = pseudValue
    initial.value.matcher = matcher.value
    initial.value.behavior = behaviorValue
    initial.value.priority = priorityValue
    initial.value.color = colorValue
  }
  open.value = false
}
</script>

<template>
  <Dialog :ref="setDialogRef" v-model:open="open" detached-trigger>
    <DialogContent>
      <DialogTitle>
        {{ creating ? 'Create' : 'Edit' }} rule
      </DialogTitle>
      <DialogDescription class="sr-only">
        Configure a rule: what it applies to, the value to match, how it matches, whether matching works are hidden, force-shown or highlighted, and how strongly it outranks other rules.
      </DialogDescription>
      <div flex="~ col gap-4" pt-4>
        <label flex="~ col gap-1">
          <span text="sm muted-fg">Applies to</span>
          <Select v-model="target" h-10 w-full>
            <SelectItem v-for="t in RULE_TARGETS" :key="t" :value="t">
              {{ ruleTargetLabel(t) }}
            </SelectItem>
          </Select>
          <p text="xs muted-fg" pl-1>
            "Any tag" matches a tag of any type; the tag types below it restrict the rule to that one type
            (see <ArchiveLink path="/faq/tags#tagtypes">this link</ArchiveLink>). Author, Work and Series match the
            byline, the work itself, and any series it belongs to.
          </p>
        </label>

        <label flex="~ col gap-1">
          <span text="sm muted-fg">{{ isAuthor ? 'User ID' : isEntity ? 'Name or id' : 'Tag name' }}</span>
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
                @update:model-value="(v) => matcher = (v ?? matcher) as Rule['matcher']"
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
          <p v-if="isEntity" text="xs muted-fg" pl-1>
            Enter the title, or the numeric id from the URL. A purely numeric value matches the id exactly;
            otherwise the title is matched using the chosen matcher.
          </p>
        </label>

        <label v-if="isAuthor" flex="~ col gap-1">
          <span text="sm muted-fg">Pseud filter</span>
          <Input
            v-model="pseud"
            type="text"
            text="base" h-10 w-full py-2 pl-2 pr-15
          />
          <p text="xs muted-fg" pl-1>
            An author rule matches all that author's pseudonyms by default. To restrict it to works posted under one
            pseudonym, enter that pseudonym here.
          </p>
        </label>

        <label flex="~ col gap-1">
          <span text="sm muted-fg">Behavior</span>
          <Select v-model="behavior" h-10 w-full>
            <SelectItem value="hide">
              Hide matching works
            </SelectItem>
            <SelectItem value="invert">
              Always show (unless a higher-priority rule hides it)
            </SelectItem>
            <SelectItem value="highlight">
              Highlight the match (does not hide)
            </SelectItem>
            <SelectItem v-if="canHideFilter" value="hideFilter">
              Hide the tag itself (does not hide works)
            </SelectItem>
            <SelectItem value="none">
              None — keep the rule, but do nothing
            </SelectItem>
          </Select>
          <p v-if="behavior === 'none'" text="xs muted-fg" pl-1>
            The rule is kept exactly as it is — value, matcher, priority and color — but matches nothing anywhere:
            no hiding, no highlight, no indicator on the page. Switch it back to another behavior to turn it on again.
          </p>
        </label>

        <label flex="~ col gap-1">
          <span text="sm muted-fg">Priority</span>
          <Input
            v-model.number="priority"
            type="number"
            :min="MIN_PRIORITY"
            :max="MAX_PRIORITY"
            text="base" h-10 w-full py-2 pl-2
          />
          <p v-if="behavior === 'none'" text="xs muted-fg" pl-1>
            {{ MIN_PRIORITY }}–{{ MAX_PRIORITY }}. Nothing while the rule is disabled — kept for whenever it is
            turned back on.
          </p>
          <p v-else text="xs muted-fg" pl-1>
            {{ MIN_PRIORITY }}–{{ MAX_PRIORITY }}. When several rules match one work, the highest priority decides
            whether it is hidden; a tie goes to "always show". Choosing a behavior resets this to its default
            ({{ behaviorDefaultPriority }} for this one), so raise a hide rule above an "always show" to make it win
            anyway.
          </p>
        </label>

        <label v-if="behavior === 'invert'" flex="~ items-center gap-2" text="sm">
          <input v-model="noHighlight" type="checkbox">
          <span text="muted-fg">No highlight (don't colour the match)</span>
        </label>

        <label v-if="showColor" flex="~ col gap-1">
          <span text="sm muted-fg">Highlight color</span>
          <ColorInput v-model="color">
            <span text="xs muted-fg">Shown as a highlight behind the match on results.</span>
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
