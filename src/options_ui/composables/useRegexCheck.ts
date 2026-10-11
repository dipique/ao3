import type { Ref } from 'vue'

import { REGEX_CHECKING_HOLD_MS } from '#common'

import type { RegexJob, RegexRun } from '../model/regexCheck.ts'
import type { RuleDraft } from '../model/ruleEditor.ts'
import type { KnownPool } from './useKnownTags.ts'

import { runOf, sameJob } from '../model/regexCheck.ts'
import { checkedNames, checkedPattern, regexTester } from '../model/ruleEditor.ts'

/**
 * The rule editor's check of its Regex pattern, while the editor is `open`.
 * The pattern runs over the tester's `subject` and, for a kind of tag, the
 * names known here for it (`known`), in a worker under the time budget
 * ({@link useRegexRunner}); `run` is where the check stands. Each change to
 * the pattern, the subject or the names asks for a new check at once: a quick
 * pattern's comes back within a frame, so a pause in typing would only hold
 * the verdict back.
 *
 * `tester` is the regex tester as drawn. While a check of what is typed to test
 * runs, it keeps what it showed for {@link REGEX_CHECKING_HOLD_MS}, so a quick
 * check changes it once, and says it is checking after that.
 */
export function useRegexCheck(draft: Ref<RuleDraft>, subject: Ref<string>, known: Ref<KnownPool | null>, open: Ref<boolean>) {
  const runner = useRegexRunner()

  const pattern = computed(() => (open.value ? checkedPattern(draft.value) : null))
  const names = computed(() => checkedNames(draft.value.target, known.value))
  /** Made again only when the subject or the names change, so a job keeps its list while they don't. */
  const subjects = computed(() => (names.value ? [subject.value, ...names.value] : null))
  const job = computed<RegexJob | 'loading' | null>(() => {
    if (pattern.value === null)
      return null
    return subjects.value ? { pattern: pattern.value, subjects: subjects.value } : 'loading'
  })
  const run = computed<RegexRun>(() => runOf(job.value, runner.ended.value))

  /** Whether the check now under way began {@link REGEX_CHECKING_HOLD_MS} ago or more. */
  const long = ref(false)
  let hold: ReturnType<typeof setTimeout> | undefined
  watch(job, (next, last) => {
    const changed = next === 'loading' || last === 'loading' ? next !== last : !sameJob(next, last)
    if (!changed)
      return
    if (next && next !== 'loading')
      runner.run(next)
    long.value = false
    clearTimeout(hold)
    hold = setTimeout(() => long.value = true, REGEX_CHECKING_HOLD_MS)
  })
  onScopeDispose(() => clearTimeout(hold))

  watch(open, (isOpen) => {
    if (isOpen)
      runner.warm()
    else
      runner.cancel()
  }, { immediate: true })

  const tester = computed(() => regexTester(draft.value, subject.value, run.value))
  const shown = useHeld(tester, () => tester.value?.verdict.kind === 'checking' && !long.value)

  return reactive({
    run,
    tester: shown,
    /** How the check ends, once it isn't under way. */
    settled: () => until(run).toMatch(now => now.kind !== 'running'),
  })
}
