import type { options } from '#common'

import { OptionRowEdits } from './context.ts'
import { useOption } from './useOptions.ts'

/**
 * {@link useOption}, for a control in a settings row: the row is told which
 * option the control edits, so it can say whether its setting syncs.
 */
export function useRowOption<K extends options.Id>(id: K): ReturnType<typeof useOption<K>> {
  OptionRowEdits.inject(null)?.(id)
  return useOption(id)
}
