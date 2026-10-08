import type { Ref } from 'vue'

import { archivePause } from '#content_script/archiveFetch.js'

import type { CanonicalAsk } from '../model/canonicalTags.ts'
import type { RegexJob, RegexRun } from '../model/regexCheck.ts'
import type { RuleDraft } from '../model/ruleEditor.ts'
import type { KnownPool } from './useKnownTags.ts'

import { answeredNames, canonicalAsks, canonicalPreview, nextAsk, offersCanonical, withPress } from '../model/canonicalTags.ts'
import { runOf, sameJob } from '../model/regexCheck.ts'
import { checkedPattern } from '../model/ruleEditor.ts'
import { NO_ANSWERS, withAnswer, withFailure, withRefusal } from '../model/tagSuggestions.ts'
import { askAutocomplete } from './useTagSuggestions.ts'

/**
 * The rule editor's preview of the canonical tags its Regex pattern matches,
 * from the editor opening to it closing: `draft` is the editor's draft and
 * `open` whether it is open. What the preview shows, and what a press asks AO3,
 * is {@link file://../model/canonicalTags.ts}; this asks, and runs the pattern
 * over AO3's answers.
 *
 * The names known here (`known`) are matched by the editor's check of the
 * pattern (`check`, {@link useRegexCheck}); AO3's answers by a run of their
 * own, under the same time budget ({@link useRegexRunner}). While either runs,
 * the preview keeps what it showed, so an edit changes it once.
 *
 * AO3 is asked only on a press that opens the preview, a few questions at
 * most, one at a time, each through {@link askAutocomplete}. One that would
 * have to wait for the archive is never sent: the press stops, and the preview
 * says why. While it is open, an edit to the pattern filters the same names
 * again; a change of target closes it.
 */
export function useCanonicalTags(draft: Ref<RuleDraft>, open: Ref<boolean>, known: Ref<KnownPool | null>, check: { run: RegexRun }) {
  const shown = ref(false)
  const state = shallowRef(NO_ANSWERS)
  const asks = shallowRef<readonly CanonicalAsk[]>([])
  const boxId = useId()
  const runner = useRegexRunner()

  let asking: AbortController | null = null

  function close() {
    asking?.abort()
    asking = null
    shown.value = false
    asks.value = []
  }

  async function askEach(press: readonly CanonicalAsk[], signal: AbortSignal) {
    for (;;) {
      const next = nextAsk(state.value, press, archivePause())
      state.value = next.state
      if (!next.send)
        return
      const question = next.send
      const answer = await askAutocomplete(question.path, signal)
      if (signal.aborted)
        return
      state.value = answer.kind === 'names'
        ? withAnswer(state.value, question, answer.names)
        : answer.kind === 'refused' ? withRefusal(state.value, archivePause()) : withFailure(state.value)
    }
  }

  function show() {
    close()
    shown.value = true
    state.value = withPress(state.value)
    asks.value = canonicalAsks(draft.value.target, draft.value.value)
    asking = new AbortController()
    void askEach(asks.value, asking.signal)
  }

  watch(open, () => {
    close()
    state.value = NO_ANSWERS
    runner.cancel()
  })

  watch(() => draft.value.target, close)

  onScopeDispose(close)

  const offered = computed(() => offersCanonical(draft.value))

  watch(offered, (on) => {
    if (!on)
      close()
  })

  const local = computed(() => (known.value?.target === draft.value.target ? known.value.tags : null))
  /** AO3's answers the preview shows that the check doesn't run over: the same list while they stay the same. */
  const answers = computed<readonly string[]>((last) => {
    const names = shown.value && local.value ? answeredNames(local.value, asks.value, state.value) : []
    return last && names.length === last.length && names.every((name, i) => name === last[i]) ? last : names
  })
  const answersJob = computed<RegexJob | null>(() => {
    const pattern = checkedPattern(draft.value)
    return pattern !== null && answers.value.length ? { pattern, subjects: answers.value } : null
  })
  const answersRun = computed(() => runOf(answersJob.value, runner.ended.value))

  watch(answersJob, (next, last) => {
    if (next && !sameJob(next, last))
      runner.run(next)
  })

  const preview = computed(() => (shown.value && offered.value
    ? canonicalPreview({ target: draft.value.target, pattern: draft.value.value, local: local.value, asks: asks.value, state: state.value, check: check.run, answers: answersRun.value })
    : null))

  return reactive({
    /** Whether the preview's toggle shows: in Regex mode, for any kind of tag. */
    offered,
    shown,
    boxId,
    preview: useHeld(preview, () => check.run.kind === 'running' || answersRun.value.kind === 'running'),
    /** Show the preview, asking AO3 afresh, or hide it. */
    toggle() {
      if (shown.value)
        close()
      else
        show()
    },
  })
}
