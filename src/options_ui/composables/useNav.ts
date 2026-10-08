import type { DrawnSubsection } from '../model/rail.ts'

import { categoryId } from '../model/anchors.ts'

/**
 * The page's categories, in the order they render, and what the rail calls each
 * one. A title can be too long for the rail, and the rail's name too long for a
 * chip on a narrow window, so each has a name of its own.
 */
export interface NavCategory {
  /** Its anchor id. */
  id: string
  title: string
  /** Its name on the rail. */
  railLabel: string
  /** Its name on the chip row a narrow window has in place of the rail. */
  chipLabel: string
  /** Its icon on the rail, as an icon class. */
  icon: string
  /** Its lists are what the job runs on, so the rail shows a running job on it. */
  jobs?: boolean
}

const categories = ref<NavCategory[]>([])

/** The sub-sections, each under its category, in the order they render, which is the rail's order for them. */
const subsections = ref<DrawnSubsection[]>([])

export function useNav() {
  return {
    categories,
    subsections,
  }
}

/** Put a category on the rail, in the order the categories render, and hand back its anchor id. */
export function useAddNav(category: Omit<NavCategory, 'id'>): { id: string } {
  const id = categoryId(category.title)
  const entry = { id, ...category }
  const at = categories.value.findIndex(c => c.id === id)
  categories.value = at < 0
    ? [...categories.value, entry]
    : categories.value.map((c, i) => i === at ? entry : c)

  onUnmounted(() => {
    categories.value = categories.value.filter(c => c.id !== id)
  })

  return { id }
}

/** Put a sub-section on the rail, under the category it renders in, in the order the sub-sections render. */
export function useAddSubsection(title: string, category: string | null): void {
  if (!subsections.value.some(one => one.title === title))
    subsections.value = [...subsections.value, { category, title }]

  onUnmounted(() => {
    subsections.value = subsections.value.filter(one => one.title !== title)
  })
}
