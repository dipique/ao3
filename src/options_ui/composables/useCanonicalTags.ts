import type { Ref } from 'vue'

import { fandomCache, loadFandomIndex } from '#common'
import { archivePause } from '#content_script/archiveFetch.js'

import type { CanonicalAsk, KnownTags, PoolTag } from '../model/canonicalTags.ts'
import type { RuleDraft } from '../model/ruleEditor.ts'

import { canonicalAsks, canonicalPool, canonicalPreview, nextAsk, offersCanonical, usesBundledFandoms, withPress } from '../model/canonicalTags.ts'
import { NO_ANSWERS, withAnswer, withFailure, withRefusal } from '../model/tagSuggestions.ts'
import { askAutocomplete } from './useTagSuggestions.ts'

let bundled: Promise<readonly string[]> | null = null

/** The bundled fandoms' names, read once for the page. A read that fails is tried again at the next press. */
function bundledFandoms(): Promise<readonly string[]> {
  bundled ??= loadFandomIndex().then(Object.keys, (error: unknown) => {
    bundled = null
    console.error('[rule editor] Failed to load the bundled fandom index:', error)
    return []
  })
  return bundled
}

async function knownTags(target: RuleDraft['target']): Promise<KnownTags> {
  const [names, learned] = await Promise.all([usesBundledFandoms(target) ? bundledFandoms() : [], fandomCache.get()])
  return { bundled: names, learned }
}

/**
 * The rule editor's preview of the canonical tags its Regex pattern matches,
 * from the editor opening to it closing: `draft` is the editor's draft and
 * `open` whether it is open. What the preview shows, and what a press asks AO3,
 * is {@link file://../model/canonicalTags.ts}; this loads the names known here,
 * and asks.
 *
 * AO3 is asked only on a press that opens the preview, a few questions at
 * most, one at a time, each through {@link askAutocomplete}. One that would
 * have to wait for the archive is never sent: the press stops, and the preview
 * says why. While it is open, an edit to the pattern filters the same names
 * again; a change of target closes it.
 */
export function useCanonicalTags(draft: Ref<RuleDraft>, open: Ref<boolean>) {
  const shown = ref(false)
  const state = shallowRef(NO_ANSWERS)
  const asks = shallowRef<readonly CanonicalAsk[]>([])
  const local = shallowRef<readonly PoolTag[] | null>(null)
  const boxId = useId()

  let asking: AbortController | null = null
  /** Counts presses, so what an earlier press loads lands only if it is still the latest. */
  let presses = 0

  function close() {
    presses++
    asking?.abort()
    asking = null
    shown.value = false
    asks.value = []
    local.value = null
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

  async function show() {
    close()
    const press = presses
    const { target, value } = draft.value
    shown.value = true
    state.value = withPress(state.value)
    asks.value = canonicalAsks(target, value)
    asking = new AbortController()
    void askEach(asks.value, asking.signal)
    const known = await knownTags(target)
    if (press === presses)
      local.value = canonicalPool(target, known)
  }

  watch(open, () => {
    close()
    state.value = NO_ANSWERS
  })

  watch(() => draft.value.target, close)

  onScopeDispose(close)

  const offered = computed(() => offersCanonical(draft.value))

  watch(offered, (on) => {
    if (!on)
      close()
  })

  return reactive({
    /** Whether the preview's toggle shows: in Regex mode, for any kind of tag. */
    offered,
    shown,
    boxId,
    preview: computed(() => (shown.value && offered.value
      ? canonicalPreview({ target: draft.value.target, pattern: draft.value.value, local: local.value, asks: asks.value, state: state.value })
      : null)),
    /** Show the preview, asking AO3 afresh, or hide it. */
    toggle() {
      if (shown.value)
        close()
      else
        void show()
    },
  })
}
