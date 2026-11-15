import type { ComponentInstance, ComputedRef, GlobalComponents, Ref } from 'vue'

import type { options, Rule } from '#common'

import type { DependentState } from '../model/masterGroup.ts'

export const OptionLabelId = createContext<string>('OptionLabelId')

/** From an `OptionMasterGroup` to the rows it gates. */
export const OptionMasterState = createContext<ComputedRef<DependentState>>('OptionMasterState')

/**
 * From a settings row to its control: why the control is inert, if it is, and
 * the id of the element saying so, for the control's `aria-describedby`.
 */
export const OptionRowOff = createContext<{ reason: ComputedRef<string | null>, id: string }>('OptionRowOff')

/** From a settings row to the controls in it, which tell it the options they edit. */
export const OptionRowEdits = createContext<(option: options.Id) => void>('OptionRowEdits')

/** Title of the enclosing category / sub-section, for the row search index. */
export const OptionCategoryName = createContext<string>('OptionCategoryName')
export const OptionSubsectionName = createContext<string>('OptionSubsectionName')

export const OptionRowRulesContext = createContext<{
  editDialog: Ref<ComponentInstance<GlobalComponents['Dialog']> | null>
  edit?: (value?: Rule) => void
  remove?: (value: Rule) => void
}>('OptionRowRules')
