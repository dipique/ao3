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
}

const categories = ref<NavCategory[]>([])

export function useNav() {
  return {
    categories,
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
