import type { ComponentInstance, GlobalComponents, Ref } from 'vue'

import type { Rule } from '#common'

export const OptionLabelId = createContext<string>('OptionLabelId')

/** Title of the enclosing category / sub-section, for the row search index. */
export const OptionCategoryName = createContext<string>('OptionCategoryName')
export const OptionSubsectionName = createContext<string>('OptionSubsectionName')

export const OptionRowRulesContext = createContext<{
  editDialog: Ref<ComponentInstance<GlobalComponents['Dialog']> | null>
  edit?: (value?: Rule) => void
  remove?: (value: Rule) => void
}>('OptionRowRules')
