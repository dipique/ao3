import type { Ref } from 'vue'

import { getArchiveLink } from '#common'
import { archivePause, fetchWithRetry, PATIENCE } from '#content_script/archiveFetch.js'

import type { RuleDraft } from '../model/ruleEditor.ts'
import type { SuggestRequest } from '../model/tagSuggestions.ts'

import { parseAutocomplete, suggestSource } from '../model/ruleEditor.ts'
import { CURSOR_CLOSED, CURSOR_START, NO_ANSWERS, SUGGEST_DELAY_MS, suggestBox, suggestKey, suggestRequest, whenDue, withAnswer, withFailure, withRefusal, withResume } from '../model/tagSuggestions.ts'

/** What AO3's tag autocomplete made of one question: its names, a refusal, or no answer at all. */
export type AutocompleteAnswer = { kind: 'names', names: string[] } | { kind: 'refused' } | { kind: 'failed' }

/**
 * Ask AO3's tag autocomplete one question, by the path that asks it. It goes
 * through `fetchWithRetry` with no patience, so it is paced with whatever else
 * this page asks the archive for, and a refusal comes straight back, recorded
 * for every other caller. Offline, an answer that isn't one, or an abort, is a
 * failure.
 */
export async function askAutocomplete(path: string, signal: AbortSignal): Promise<AutocompleteAnswer> {
  try {
    const res = await fetchWithRetry(getArchiveLink(path), signal, PATIENCE.suggestion)
    if (res.status === 429)
      return { kind: 'refused' }
    if (!res.ok)
      return { kind: 'failed' }
    return { kind: 'names', names: parseAutocomplete(await res.json()) }
  }
  catch {
    return { kind: 'failed' }
  }
}

/**
 * The rule editor's suggestions for its value field, from the editor opening
 * to it closing: `draft` is the editor's draft and `open` whether it is open,
 * and each opening starts afresh. What to ask and when, and what the box shows,
 * is {@link file://../model/tagSuggestions.ts}; this holds the state, waits
 * for the pause in typing, and asks AO3.
 *
 * Every request goes through `fetchWithRetry`, so it is paced with whatever
 * else this page asks the archive for, such as a caching job, and a refusal it
 * meets holds those back too. One is on its way at a time: a newer term gives
 * up the older one's.
 *
 * The box shows while the reader is in the field. The field is a combobox
 * wherever it offers suggestions, and the list a listbox it controls.
 */
export function useTagSuggestions(draft: Ref<RuleDraft>, open: Ref<boolean>) {
  const state = shallowRef(NO_ANSWERS)
  const cursor = shallowRef(CURSOR_START)
  const focused = ref(false)
  const listId = useId()

  let typing: ReturnType<typeof setTimeout> | undefined
  let resuming: ReturnType<typeof setTimeout> | undefined
  let asking: AbortController | null = null

  const source = computed(() => suggestSource(draft.value.target))
  const request = computed(() => suggestRequest(source.value, draft.value.matcher, draft.value.value))
  const box = computed(() => suggestBox(state.value, source.value, draft.value.matcher, draft.value.value))
  const names = computed(() => (box.value.kind === 'names' ? box.value.options : []))
  const expanded = computed(() => focused.value && cursor.value.shown && names.value.length > 0)
  const optionId = (index: number) => `${listId}-${index}`

  function stop() {
    clearTimeout(typing)
    clearTimeout(resuming)
    asking?.abort()
    asking = null
  }

  function resumeAt(until: number) {
    clearTimeout(resuming)
    resuming = setTimeout(() => {
      state.value = withResume(state.value)
      due()
    }, Math.max(0, until - Date.now()))
  }

  function due() {
    const wanted = request.value
    const next = whenDue(state.value, wanted, archivePause())
    state.value = next.state
    if (next.send && wanted)
      void ask(wanted)
    else if (next.state.pausedUntil)
      resumeAt(next.state.pausedUntil)
  }

  async function ask(question: SuggestRequest) {
    asking?.abort()
    const controller = new AbortController()
    asking = controller
    const answer = await askAutocomplete(question.path, controller.signal)
    if (asking === controller)
      asking = null
    if (controller.signal.aborted)
      return
    if (answer.kind === 'refused') {
      state.value = withRefusal(state.value, archivePause())
      if (state.value.pausedUntil)
        resumeAt(state.value.pausedUntil)
      return
    }
    state.value = answer.kind === 'names' ? withAnswer(state.value, question, answer.names) : withFailure(state.value)
  }

  watch(open, () => {
    stop()
    state.value = NO_ANSWERS
    cursor.value = CURSOR_START
    focused.value = false
  })

  watch(names, () => {
    if (cursor.value.active !== -1)
      cursor.value = { ...cursor.value, active: -1 }
  })

  watch(() => cursor.value.active, (active) => {
    if (active !== -1)
      void nextTick(() => document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' }))
  })

  onScopeDispose(stop)

  return reactive({
    box,
    /** Whether the box shows: its names while the list is open, or its note. */
    shown: computed(() => focused.value && (box.value.kind === 'names' ? cursor.value.shown : box.value.kind !== 'none')),
    listId,
    optionId,
    active: computed(() => cursor.value.active),
    /** The value field's own attributes for its suggestions. */
    field: computed(() => (draft.value.matcher === 'exact' && source.value.kind !== 'none'
      ? {
          'role': 'combobox',
          'aria-autocomplete': 'list' as const,
          'aria-expanded': expanded.value,
          'aria-controls': expanded.value ? listId : undefined,
          'aria-activedescendant': expanded.value && cursor.value.active !== -1 ? optionId(cursor.value.active) : undefined,
        }
      : {})),
    /** The reader typed: the list shows again, and the term is asked about once typing pauses. */
    typed() {
      cursor.value = CURSOR_START
      clearTimeout(typing)
      typing = setTimeout(due, SUGGEST_DELAY_MS)
    },
    keydown(event: KeyboardEvent) {
      if (event.isComposing)
        return
      const step = suggestKey(cursor.value, event.key, names.value.length)
      if (!step)
        return
      // Escape included: a dialog doesn't close on an Escape whose default is prevented.
      event.preventDefault()
      cursor.value = step.cursor
      if (step.pick !== null)
        draft.value.value = names.value[step.pick]!.name
    },
    focus() {
      focused.value = true
    },
    blur() {
      focused.value = false
    },
    /** Write AO3's spelling of a name into the field. */
    pick(name: string) {
      draft.value.value = name
      cursor.value = CURSOR_CLOSED
    },
  })
}
