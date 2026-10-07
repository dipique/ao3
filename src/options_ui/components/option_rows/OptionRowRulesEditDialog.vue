<script setup lang="ts">
import type { ComponentInstance, GlobalComponents } from 'vue'

import type { Rule, RuleTarget } from '#common'

import { HIGHLIGHT_PRESETS, isTagTarget, MAX_PRIORITY, MIN_PRIORITY, RULE_TARGETS, ruleTargetColor, ruleTargetLabel } from '#common'

import type { RuleAction, Swatch } from '../../model/ruleEditor.ts'

import { canSave, draftRule, HIDE_TAG_OFF, openDraft, regexTester, RULE_ACTIONS, RULE_OFF_HELP, ruleSummary, usesColor, usesPriority, valueField, withAction, withSwatch, withTarget } from '../../model/ruleEditor.ts'

const context = OptionRowRulesContext.inject()
const { filters, colors } = useOption('rules')

const open = ref(false)
/** The stored rule being edited, or null while adding one. */
const editing = shallowRef<Rule | null>(null)
const draft = ref(openDraft(undefined, {}))
/** What the regex tester tests the pattern against. It is no part of the rule. */
const testSubject = ref('')
const suggest = useTagSuggestions(draft, open)
const canonical = useCanonicalTags(draft, open)

/*
  What the editor says of its own accord is said in live regions that are
  there before the words come: a screen reader may say nothing of a region
  added with its words already in it. The suggestions' note is said in a
  region of its own, in place while the editor is open, since the box it shows
  in comes and goes. The canonical preview's note fills its region a frame
  after the region is drawn.
*/
const suggestNote = computed(() => (suggest.box.kind === 'paused' || suggest.box.kind === 'unavailable' ? suggest.box.text : ''))
const canonicalNote = ref('')
watch(() => canonical.preview?.note ?? '', (note) => {
  requestAnimationFrame(() => {
    canonicalNote.value = note
  })
}, { immediate: true })

const valueId = useId()
const testId = useId()
const pseudId = useId()
const priorityId = useId()
const enabledId = useId()
const hideTagOffId = useId()

const MATCHERS = [
  { value: 'exact', label: 'Exact', tip: 'The whole name, exactly', icon: 'i-codicon-symbol-string' },
  { value: 'contains', label: 'Contains', tip: 'Anywhere in the name', icon: 'i-codicon-whole-word' },
  { value: 'regex', label: 'Regex', tip: 'A regular expression', icon: 'i-codicon-regex' },
] as const

/** The glyphs the rules list draws each action with. */
const ACTION_ICONS: Record<RuleAction, string> = {
  hide: 'i-tabler-eye-off',
  collapse: 'i-mdi-arrow-collapse-vertical',
  highlight: 'i-mdi-star',
  invert: 'i-tabler-eye-exclamation',
  hideFilter: 'i-mdi-tag-off',
}

const field = computed(() => valueField(draft.value.target, draft.value.matcher, draft.value.value))
const tester = computed(() => regexTester(draft.value, testSubject.value))
const hideTagOff = computed(() => !isTagTarget(draft.value.target))
const targetDefault = computed(() => ruleTargetColor(draft.value.target, colors.value))
const actionHelp = computed(() => draft.value.enabled
  ? RULE_ACTIONS.find(action => action.value === draft.value.action)!.help
  : RULE_OFF_HELP)
const noHighlight = computed(() => draft.value.action === 'invert' && draft.value.noHighlight)
const sentence = computed(() => ruleSummary(draftRule(draft.value, colors.value)))

context.edit = (rule?: Rule) => {
  editing.value = rule ?? null
  draft.value = openDraft(rule, colors.value)
  testSubject.value = ''
  open.value = true
}

context.remove = (rule: Rule) => {
  filters.value.splice(filters.value.indexOf(rule), 1)
}

function setDialogRef(ref: unknown) {
  context.editDialog.value = ref as ComponentInstance<GlobalComponents['Dialog']>
}

function save() {
  if (!canSave(draft.value))
    return
  const rule = draftRule(draft.value, colors.value)
  const at = editing.value ? filters.value.indexOf(editing.value) : -1
  if (at === -1)
    filters.value.push(rule)
  else
    filters.value.splice(at, 1, rule)
  open.value = false
}
</script>

<template>
  <Dialog :ref="setDialogRef" v-model:open="open" detached-trigger>
    <DialogContent sections>
      <div class="rule-editor__head">
        <RekaDialogTitle class="rule-editor__title font-serif">
          {{ editing ? 'Edit rule' : 'Add a rule' }}
        </RekaDialogTitle>
        <DialogDescription class="sr-only">
          What the rule applies to, the text it matches and how, what it does with the works it matches, and how
          strongly it outranks other rules.
        </DialogDescription>
      </div>

      <div class="rule-editor__body">
        <DialogField label="Applies to">
          <RekaRadioGroupRoot
            :model-value="draft.target"
            aria-label="What the rule matches"
            class="chips"
            @update:model-value="draft = withTarget(draft, $event as RuleTarget)"
          >
            <RekaRadioGroupItem v-for="target in RULE_TARGETS" :key="target" :value="target" class="chip input-ring">
              {{ ruleTargetLabel(target) }}
            </RekaRadioGroupItem>
          </RekaRadioGroupRoot>
        </DialogField>

        <DialogField :label="field.label" :label-for="valueId">
          <template #default="{ helpId }">
            <div class="value-row">
              <input
                :id="valueId"
                v-model="draft.value"
                v-bind="suggest.field"
                type="text"
                class="text-field input-ring"
                :class="{ 'text-field--mono': draft.matcher === 'regex' }"
                :placeholder="field.placeholder"
                :aria-describedby="helpId"
                autocomplete="off"
                spellcheck="false"
                @input="suggest.typed"
                @keydown="suggest.keydown"
                @focus="suggest.focus"
                @blur="suggest.blur"
              >
              <RekaRadioGroupRoot
                :model-value="draft.matcher"
                aria-label="How to match"
                class="seg"
                :disabled="field.byId"
                @update:model-value="draft.matcher = $event as Rule['matcher']"
              >
                <RekaRadioGroupItem
                  v-for="matcher in MATCHERS"
                  :key="matcher.value"
                  :value="matcher.value"
                  :title="matcher.tip"
                  class="seg__item input-ring"
                >
                  <Icon v-bind="{ [matcher.icon]: '' }" />{{ matcher.label }}
                </RekaRadioGroupItem>
              </RekaRadioGroupRoot>
              <!-- A press in the box would take the focus out of the field, and the box with it. -->
              <div v-if="suggest.shown" class="suggest" :data-suggest="suggest.box.kind" @mousedown.prevent>
                <ul v-if="suggest.box.kind === 'names'" :id="suggest.listId" role="listbox" aria-label="Suggestions" class="suggest__list">
                  <li
                    v-for="(option, index) in suggest.box.options"
                    :id="suggest.optionId(index)"
                    :key="option.name"
                    role="option"
                    :aria-selected="index === suggest.active"
                    class="suggest__option"
                    :class="{ 'ring-inset input-ring-visible': index === suggest.active }"
                    @click="suggest.pick(option.name)"
                  >
                    <!-- v-html is safe here: `highlight` escapes the name and only ever adds <mark>. -->
                    <!-- eslint-disable-next-line vue/no-v-html -->
                    <span class="suggest__name" v-html="option.html" />
                    <span class="suggest__kind" aria-hidden="true">canonical</span>
                  </li>
                </ul>
                <p v-else-if="suggest.box.kind !== 'none'" class="suggest__note">
                  {{ suggest.box.text }}
                </p>
              </div>
            </div>
            <p role="status" class="sr-only">
              {{ suggestNote }}
            </p>
          </template>
          <template #help>
            {{ field.help }}
          </template>
        </DialogField>

        <DialogField v-if="tester" label="Test it" :label-for="testId">
          <template #default="{ helpId }">
            <div class="value-row">
              <input
                :id="testId"
                v-model="testSubject"
                type="text"
                class="text-field input-ring"
                :placeholder="tester.placeholder"
                :aria-describedby="helpId"
                autocomplete="off"
                spellcheck="false"
              >
              <span
                role="status"
                class="verdict"
                :class="`verdict--${tester.verdict.kind}`"
                :data-regex-verdict="tester.verdict.kind"
              >
                <SeverityGlyph v-if="tester.verdict.kind === 'invalid'" severity="destructive" />
                <span v-else-if="tester.verdict.kind === 'match'" class="i-tabler-check text-success" aria-hidden="true" />
                {{ tester.label }}
              </span>
            </div>
            <template v-if="canonical.offered">
              <button
                type="button"
                class="link-button canon-toggle input-ring"
                :aria-expanded="canonical.shown"
                :aria-controls="canonical.shown ? canonical.boxId : undefined"
                @click="canonical.toggle"
              >
                {{ canonical.shown ? 'Hide matching canonical tags' : 'Show matching canonical tags' }}
              </button>
              <div v-if="canonical.preview" :id="canonical.boxId" class="canon" data-canonical>
                <p v-if="canonical.preview.head || canonical.preview.sources" class="canon__head" aria-live="polite">
                  <span v-if="canonical.preview.head" data-canonical-part="head">{{ canonical.preview.head }}</span>
                  <span v-if="canonical.preview.sources" data-canonical-part="sources">{{ canonical.preview.sources }}</span>
                </p>
                <ul v-if="canonical.preview.rows.length" class="canon__list" aria-label="Matching canonical tags">
                  <!-- v-html is safe here: `markSpans` escapes the name and only ever adds <mark>. -->
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <li v-for="row in canonical.preview.rows" :key="row.name" class="canon__tag" data-canonical-part="tag" v-html="row.html" />
                </ul>
                <p v-if="canonical.preview.more" class="canon__line" data-canonical-part="more">
                  {{ canonical.preview.more }}
                </p>
                <p v-if="canonical.preview.empty" class="canon__line" data-canonical-part="empty">
                  {{ canonical.preview.empty }}
                </p>
                <p
                  role="status"
                  class="canon__line"
                  :class="{ 'canon__line--waiting': !canonicalNote }"
                  :data-canonical-part="canonicalNote ? 'note' : undefined"
                >
                  {{ canonicalNote }}
                </p>
              </div>
            </template>
          </template>
          <template #help>
            {{ tester.help }}
          </template>
        </DialogField>

        <DialogField v-if="draft.target === 'author'" label="Pseud" :label-for="pseudId">
          <template #default="{ helpId }">
            <input
              :id="pseudId"
              v-model="draft.pseud"
              type="text"
              class="text-field input-ring"
              placeholder="All pseuds"
              :aria-describedby="helpId"
              autocomplete="off"
              spellcheck="false"
            >
          </template>
          <template #help>
            Leave empty to cover every pseud the account writes under.
          </template>
        </DialogField>

        <DialogField label="Then">
          <template #default="{ helpId }">
            <RekaRadioGroupRoot
              :model-value="draft.action"
              aria-label="What the rule does"
              :aria-describedby="helpId"
              class="acts"
              :disabled="!draft.enabled"
              @update:model-value="draft = withAction(draft, $event as RuleAction)"
            >
              <RekaRadioGroupItem
                v-for="action in RULE_ACTIONS"
                :key="action.value"
                :value="action.value"
                class="act input-ring"
                :disabled="action.value === 'hideFilter' && hideTagOff"
                :title="action.value === 'hideFilter' && hideTagOff ? HIDE_TAG_OFF : undefined"
                :aria-describedby="action.value === 'hideFilter' && hideTagOff ? hideTagOffId : undefined"
              >
                <span :class="ACTION_ICONS[action.value]" class="act__icon" aria-hidden="true" />
                {{ action.label }}
              </RekaRadioGroupItem>
            </RekaRadioGroupRoot>
            <span :id="hideTagOffId" hidden>{{ HIDE_TAG_OFF }}</span>
          </template>
          <template #help>
            {{ actionHelp }}
          </template>
        </DialogField>

        <DialogField v-if="usesColor(draft.action)" label="Colour">
          <div class="swatch-row">
            <RekaRadioGroupRoot
              :model-value="draft.swatch"
              aria-label="Highlight colour"
              class="swatches"
              :disabled="noHighlight"
              @update:model-value="draft = withSwatch(draft, $event as Swatch)"
            >
              <RekaRadioGroupItem
                value="default"
                class="swatch input-ring"
                aria-label="Default"
                :title="`Default: your colour for ${ruleTargetLabel(draft.target)}`"
                :style="{ backgroundColor: targetDefault }"
              />
              <RekaRadioGroupItem
                v-for="preset in HIGHLIGHT_PRESETS"
                :key="preset.name"
                :value="preset.name"
                class="swatch input-ring"
                :aria-label="preset.name"
                :title="preset.name"
                :style="{ backgroundColor: preset.color }"
              />
              <RekaRadioGroupItem
                value="custom"
                class="swatch swatch--custom input-ring"
                aria-label="Custom"
                title="Custom: any colour"
              />
            </RekaRadioGroupRoot>
            <OptionRowRuleColors>
              <button type="button" class="link-button input-ring">
                Your default highlight colours
              </button>
            </OptionRowRuleColors>
          </div>
          <label v-if="draft.swatch === 'custom' && !noHighlight" class="custom-colour">
            <span class="sr-only">Custom colour</span>
            <ColorInput v-model="draft.color" />
          </label>
          <label v-if="draft.action === 'invert'" class="no-highlight">
            <input v-model="draft.noHighlight" type="checkbox" class="input-ring">
            No highlight: don’t colour the match
          </label>
        </DialogField>

        <DialogField v-if="usesPriority(draft.action)" label="Priority" :label-for="priorityId">
          <div class="priority-row">
            <Stepper
              :id="priorityId"
              v-model="draft.priority"
              :min="MIN_PRIORITY"
              :max="MAX_PRIORITY"
              decrement-label="Lower priority"
              increment-label="Raise priority"
            />
            <span class="priority-row__note">When rules disagree about a work, the highest priority wins; always-show wins a tie.</span>
          </div>
        </DialogField>

        <p class="summary" aria-live="polite">
          <span class="summary__icon i-tabler-info-circle" aria-hidden="true" />
          <span><template v-for="(part, index) in sentence" :key="index"><b v-if="part.kind === 'verb'">{{ part.text }}</b><span v-else-if="part.kind === 'value'" class="summary__value">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></span>
        </p>
      </div>

      <div class="rule-editor__foot">
        <Switch :id="enabledId" v-model="draft.enabled" />
        <label :for="enabledId" class="rule-editor__enabled">Rule Enabled</label>
        <RekaDialogClose class="cancel-button input-ring" aria-keyshortcuts="Escape">
          <kbd aria-hidden="true">Esc</kbd> Cancel
        </RekaDialogClose>
        <button type="button" class="save-button input-ring" :disabled="!canSave(draft)" @click="save">
          {{ editing ? 'Save' : 'Add rule' }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.rule-editor__head {
  display: flex;
  align-items: center;
  /* Room on the right for the dialog's own close button. */
  padding: 16px 48px 12px 18px;
}
.rule-editor__title {
  color: rgb(var(--color-brand-fg));
  font-size: 19px;
}
.rule-editor__body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 2px 18px 6px;
  scrollbar-width: thin;
}
.rule-editor__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 18px 16px;
  border-top: 1px solid rgb(var(--color-hair));
}
.rule-editor__enabled {
  font-size: 12px;
}

.rule-editor__body :deep(.chips) {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.rule-editor__body :deep(.chip) {
  height: 26px;
  padding: 0 10px;
  border: 1px solid rgb(var(--color-input));
  border-radius: 999px;
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-muted-fg));
  font-size: 12px;
  cursor: pointer;
}

.value-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.text-field {
  flex: 1 1 10rem;
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid rgb(var(--color-input));
  border-radius: 7px;
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-default-fg));
  font-size: 13px;
}
.text-field--mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

/* Under the field and the matcher beside it; on a narrow dialog, where the
   matcher goes under the field, between the two. */
.suggest {
  flex-basis: 100%;
  order: 3;
  margin-top: -4px;
  overflow: hidden;
  border: 1px solid rgb(var(--color-border));
  border-radius: 8px;
  background-color: rgb(var(--color-default));
}
/* About seven names in sight; AO3 offers up to sixteen. */
.suggest__list {
  max-height: 204px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
}
.suggest__option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 5px 10px;
  font-size: 12.5px;
  line-height: 18px;
  cursor: pointer;
}
.suggest__option + .suggest__option {
  border-top: 1px solid rgb(var(--color-hair));
}
.suggest__option:hover,
.suggest__option[aria-selected='true'] {
  background-color: var(--row-hover);
}
.suggest__name {
  min-width: 0;
}
.suggest__name :deep(mark) {
  background: none;
  color: inherit;
  font-weight: 700;
}
.suggest__kind {
  flex: none;
  margin-left: auto;
  color: rgb(var(--color-muted-fg));
  font-size: 11px;
}
.suggest__note {
  padding: 6px 10px;
  color: rgb(var(--color-muted-fg));
  font-size: 12px;
  line-height: 16px;
}

.verdict {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid rgb(var(--color-input));
  border-radius: 999px;
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
  font-weight: 700;
}
/*
 * A verdict's colour is on its edge, its tint and its glyph. Its words are in
 * the body colour: green or red words that small don't read on the light ground.
 */
.verdict--match {
  border-color: rgb(var(--color-success) / 0.45);
  background-color: rgb(var(--color-success) / 0.1);
  color: rgb(var(--color-default-fg));
}
.verdict--invalid {
  border-color: rgb(var(--color-destructive) / 0.45);
  background-color: rgb(var(--color-destructive) / 0.1);
  color: rgb(var(--color-default-fg));
}

.canon-toggle {
  margin-top: 8px;
}
.canon {
  margin-top: 6px;
  overflow: hidden;
  border: 1px solid rgb(var(--color-border));
  border-radius: 8px;
  background-color: rgb(var(--color-default));
}
.canon > * + * {
  border-top: 1px solid rgb(var(--color-hair));
}
/* The head's words are the text colour at 57%, as a list header's are, which reads at AA on `muted`. */
.canon__head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 2px 12px;
  padding: 6px 10px;
  background-color: rgb(var(--color-muted));
  color: rgb(var(--color-default-fg) / 0.57);
  font-size: 11.5px;
  line-height: 16px;
}
.canon__head + * {
  border-top-color: rgb(var(--color-border));
}
/* About five names in sight. */
.canon__list {
  max-height: 140px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
}
.canon__tag {
  min-height: 26px;
  padding: 4px 10px;
  font-size: 12.5px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.canon__tag + .canon__tag {
  border-top: 1px solid rgb(var(--color-hair));
}
.canon__tag :deep(mark) {
  padding: 0 1px;
  border-radius: 3px;
  background-color: rgb(var(--color-brand-fg) / 0.1);
  color: rgb(var(--color-brand-fg));
}
.canon__line {
  padding: 8px 10px;
  color: rgb(var(--color-muted-fg));
  font-size: 12px;
  line-height: 16px;
}
/* The note's region, in place with nothing to say yet. */
.canon > .canon__line--waiting {
  padding: 0;
  border-top: none;
}

.rule-editor__body :deep(.seg) {
  display: inline-flex;
  flex: none;
  overflow: hidden;
  border: 1px solid rgb(var(--color-input));
  border-radius: 7px;
}
.rule-editor__body :deep(.seg__item) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: none;
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-muted-fg));
  font-size: 12px;
  cursor: pointer;
}
.rule-editor__body :deep(.seg__item + .seg__item) {
  border-left: 1px solid rgb(var(--color-input));
}

.rule-editor__body :deep(.acts) {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}
.rule-editor__body :deep(.act) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 58px;
  padding: 4px;
  border: 1px solid rgb(var(--color-input));
  border-radius: 8px;
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
  line-height: 14px;
  text-align: center;
  cursor: pointer;
}
.act__icon {
  font-size: 17px;
}

/*
 * The picked choice of each group is a tinted chip, and changes weight as
 * well as colour, so it reads in greyscale too.
 */
.rule-editor__body :deep(.chip[data-state='checked']),
.rule-editor__body :deep(.seg__item[data-state='checked']),
.rule-editor__body :deep(.act[data-state='checked']) {
  border-color: rgb(var(--color-brand-fg) / 0.32);
  background-color: rgb(var(--color-brand-fg) / 0.1);
  color: rgb(var(--color-brand-fg));
  font-weight: 600;
}
.rule-editor__body :deep(.seg__item[data-state='checked']) {
  border-color: rgb(var(--color-input));
}
.rule-editor__body :deep(.chip:hover:where(:enabled):not([data-state='checked'])),
.rule-editor__body :deep(.seg__item:hover:where(:enabled):not([data-state='checked'])),
.rule-editor__body :deep(.act:hover:where(:enabled):not([data-state='checked'])) {
  background-color: var(--row-hover);
  color: rgb(var(--color-default-fg));
}
.rule-editor__body :deep(.chip:disabled),
.rule-editor__body :deep(.seg__item:disabled),
.rule-editor__body :deep(.act:disabled) {
  cursor: default;
  opacity: 0.48;
}

.swatch-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-height: 32px;
}
.rule-editor__body :deep(.swatches) {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rule-editor__body :deep(.swatch) {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.rule-editor__body :deep(.swatch[data-state='checked']) {
  border-color: rgb(var(--color-default-fg));
  box-shadow: 0 0 0 2px rgb(var(--color-card)) inset;
}
.rule-editor__body :deep(.swatch:hover:where(:enabled):not([data-state='checked'])) {
  border-color: rgb(var(--color-muted-fg));
}
.rule-editor__body :deep(.swatch:disabled) {
  cursor: default;
  opacity: 0.48;
}
/* A colour wheel: any colour at all. */
.rule-editor__body :deep(.swatch--custom) {
  background: conic-gradient(
    hsl(0deg 84% 60%),
    hsl(38deg 92% 50%),
    hsl(142deg 71% 45%),
    hsl(199deg 89% 48%),
    hsl(263deg 70% 50%),
    hsl(0deg 84% 60%)
  );
}
.link-button {
  padding: 0;
  border: none;
  background: none;
  color: rgb(var(--color-brand-fg));
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.custom-colour {
  display: block;
  margin-top: 8px;
}
.no-highlight {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
}

.priority-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.priority-row__note {
  flex: 1 1 12rem;
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
  line-height: 16px;
}
.summary {
  display: flex;
  gap: 9px;
  margin: 4px 0 2px;
  padding: 11px 12px;
  border: 1px solid rgb(var(--color-hair));
  border-radius: 9px;
  background-color: rgb(var(--color-sunken));
  font-size: 12.5px;
  line-height: 18px;
}
.summary__icon {
  flex: none;
  margin-top: 1px;
  color: rgb(var(--color-muted-fg));
  font-size: 15px;
}
.summary b {
  font-weight: 700;
}
.summary__value {
  color: rgb(var(--color-brand-fg));
}

.rule-editor__foot :deep(.cancel-button) {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  margin-left: auto;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: rgb(var(--color-muted-fg));
  font-size: 12.5px;
  cursor: pointer;
}
.rule-editor__foot :deep(.cancel-button:hover) {
  background-color: var(--row-hover);
  color: rgb(var(--color-default-fg));
}
.rule-editor__foot :deep(.cancel-button kbd) {
  padding: 1px 5px;
  border: 1px solid rgb(var(--color-border));
  border-radius: 4px;
  font: inherit;
  font-size: 10.5px;
  line-height: 1.3;
}
/* The commit button is the big target, so a near miss lands on nothing rather than on Cancel. */
.save-button {
  min-width: 168px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid rgb(var(--color-primary));
  border-radius: 7px;
  background-color: rgb(var(--color-primary));
  color: rgb(var(--color-primary-fg));
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.save-button:hover:where(:enabled) {
  background-color: rgb(var(--color-primary) / 0.9);
}
.save-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

@container (max-width: 480px) {
  .save-button {
    min-width: 0;
  }
  .text-field {
    flex-basis: 100%;
  }
  .suggest {
    order: 1;
  }
  .rule-editor__body :deep(.seg) {
    order: 2;
  }
}
</style>
