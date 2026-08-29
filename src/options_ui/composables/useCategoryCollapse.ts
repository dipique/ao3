/**
 * Shared open/closed state for the option categories, so a category's own header
 * and the page-level "Collapse all" / "Expand all" buttons drive the same thing.
 *
 * Categories are open by default, so the store keeps only the exceptions — the
 * set of collapsed titles — plus a registry of what is currently on the page,
 * which is what "all" means to the two buttons. Titles are the key because
 * `useAddNav` already treats them as each category's identity.
 *
 * Nothing is persisted. The options page is opened to change a setting and shut
 * again, and reopening it to a wall of folded sections would hide the settings
 * rather than tidy them.
 */

/** Titles of every mounted category. */
const registry = ref(new Set<string>())
/** Titles currently folded shut. */
const collapsed = ref(new Set<string>())

export function useCategoryCollapse() {
  return {
    anyOpen: computed(() => [...registry.value].some(name => !collapsed.value.has(name))),
    anyCollapsed: computed(() => [...registry.value].some(name => collapsed.value.has(name))),
    collapseAll: () => registry.value.forEach(name => collapsed.value.add(name)),
    expandAll: () => collapsed.value.clear(),
  }
}

/**
 * Registers one category and hands back its own open/closed model, ready for
 * `v-model:open` on a collapsible.
 */
export function useCollapsibleCategory(name: string) {
  registry.value.add(name)

  onUnmounted(() => {
    registry.value.delete(name)
    collapsed.value.delete(name)
  })

  return {
    open: computed({
      get: () => !collapsed.value.has(name),
      set: (open: boolean) => {
        if (open)
          collapsed.value.delete(name)
        else
          collapsed.value.add(name)
      },
    }),
  }
}
