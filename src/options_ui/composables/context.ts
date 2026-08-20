import type { ComponentInstance, GlobalComponents, Ref } from 'vue'

import type { Rule } from '#common'

export const OptionLabelId = createContext<string>('OptionLabelId')

export const OptionRowRulesContext = createContext<{
  editDialog: Ref<ComponentInstance<GlobalComponents['Dialog']> | null>
  edit?: (value?: Rule) => void
  remove?: (value: Rule) => void
}>('OptionRowRules')
