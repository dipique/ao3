import type { Completion, Crossovers } from '#common'

import { COMPLETION_LABELS, CROSSOVER_LABELS } from '#common'

/**
 * Reading and writing AO3's own three-way radio filters: a blank radio for "no
 * preference" beside one radio per choice, all sharing one `*_search[<field>]`
 * name. The Sort & Filter sidebar and the advanced search page spell them the
 * same way.
 *
 * Mirrors {@link file://./wordCountFilter.ts}: we only set the control, never
 * post anything ourselves. The reader submits the filter form when they're ready.
 */
export interface RadioFilter<C extends string> {
  /**
   * The one radio that stands for the whole group, so a caller can remember
   * something about the control. Null when the page has none.
   */
  control: (root?: ParentNode) => HTMLInputElement | null
  /** Whether this page can filter on the field at all. */
  has: (root?: ParentNode) => boolean
  /** The choice currently ticked; null for the blank "no preference" radio. */
  get: (root?: ParentNode) => C | null
  /**
   * Tick `choice` — or the blank radio, for null. Returns false when the page has
   * no such control (or not that radio). Does not submit.
   */
  set: (choice: C | null, root?: ParentNode) => boolean
  /** What the pending-search prompt says once `choice` is ticked. */
  describe: (choice: C | null) => string
}

interface RadioFilterSpec<C extends string> {
  /** The `<field>` of `*_search[<field>]`. */
  field: string
  /** The radio value AO3 gives each choice. */
  values: Readonly<Record<C, string>>
  /** Names the filter in what the prompt says — "Completion". */
  name: string
  labels: Readonly<Record<C, string>>
}

export function radioFilter<C extends string>({ field, values, name, labels }: RadioFilterSpec<C>): RadioFilter<C> {
  const selector = `input[type="radio"][name$="[${field}]"]`
  const radios = (root: ParentNode = document) => [...root.querySelectorAll<HTMLInputElement>(selector)]
  const choices = Object.entries(values) as [C, string][]

  return {
    control: root => radios(root)[0] ?? null,
    has: root => radios(root).length > 0,
    get: (root) => {
      const checked = radios(root).find(radio => radio.checked)?.value
      return choices.find(([, value]) => value === checked)?.[0] ?? null
    },
    set: (choice, root) => {
      const value = choice ? values[choice] : ''
      const radio = radios(root).find(radio => radio.value === value)
      if (!radio)
        return false
      radio.checked = true
      return true
    },
    describe: choice => choice
      ? `${name} filter set to ${labels[choice].toLowerCase()}.`
      : `${name} filter cleared.`,
  }
}

/** "Completion Status" (`work_search[complete]`): `T` complete works only, `F` works in progress only. */
export const completionFilter = radioFilter<Completion>({
  field: 'complete',
  values: { complete: 'T', incomplete: 'F' },
  name: 'Completion',
  labels: COMPLETION_LABELS,
})

/** "Crossovers" (`work_search[crossover]`): `F` excludes crossovers, `T` shows nothing else. */
export const crossoverFilter = radioFilter<Crossovers>({
  field: 'crossover',
  values: { exclude: 'F', only: 'T' },
  name: 'Crossover',
  labels: CROSSOVER_LABELS,
})
