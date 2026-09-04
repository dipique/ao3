/**
 * Shared open/closed state for everything foldable on the options page —
 * categories and their sub-sections alike — so a section's own header and the
 * page-level "Collapse all" / "Expand all" buttons drive the same thing.
 *
 * Sections are open by default, so the store keeps only the exceptions (the set
 * of collapsed keys) plus a registry of what is currently on the page, which is
 * what "all" means to the two buttons. Both buttons reach sub-sections too:
 * collapsing everything and then opening one category leaves you looking at just
 * that category's sub-section headings, which is a useful way in.
 *
 * Nothing is persisted. The options page is opened to change a setting and shut
 * again, and reopening it to a wall of folded sections would hide the settings
 * rather than tidy them. (The descriptions switch, which *is* a standing
 * preference, does persist — see {@link file://./useOptionSearch.ts}.)
 */

/** Keys of every mounted section. Prefixed so a category and a sub-section can share a title. */
const registry = ref(new Set<string>())
/** Sections currently folded shut. */
const collapsed = ref(new Set<string>())

/**
 * Folds stashed while a search is running. A search shows every section that has
 * a hit, so the reader's own folds are put aside for the duration and handed
 * back when the query clears — see {@link file://./useOptionSearch.ts}.
 */
let stashed: Set<string> | null = null

export function stashCollapsed(): void {
  if (stashed)
    return
  stashed = new Set(collapsed.value)
  collapsed.value = new Set()
}

export function restoreCollapsed(): void {
  if (!stashed)
    return
  collapsed.value = stashed
  stashed = null
}

export function useCategoryCollapse() {
  return {
    anyOpen: computed(() => [...registry.value].some(key => !collapsed.value.has(key))),
    anyCollapsed: computed(() => [...registry.value].some(key => collapsed.value.has(key))),
    collapseAll: () => registry.value.forEach(key => collapsed.value.add(key)),
    expandAll: () => collapsed.value.clear(),
  }
}

/** Registers one section and hands back its `v-model:open` model. */
function useCollapsibleSection(key: string) {
  registry.value.add(key)

  // Only the registry is cleaned up. A sub-section really does unmount when its
  // category folds shut, and forgetting its state there would spring every
  // sub-section open again the moment the category was reopened — so the fold
  // itself is kept, and a section comes back the way it was left.
  onUnmounted(() => registry.value.delete(key))

  return {
    open: computed({
      get: () => !collapsed.value.has(key),
      set: (open: boolean) => {
        if (open)
          collapsed.value.delete(key)
        else
          collapsed.value.add(key)
      },
    }),
  }
}

export function useCollapsibleCategory(name: string) {
  return useCollapsibleSection(`category:${name}`)
}

/**
 * Sub-section keys carry their category, so two categories may use the same
 * sub-section heading without sharing a fold.
 */
export function useCollapsibleSubsection(category: string | null, name: string) {
  return useCollapsibleSection(`subsection:${category ?? ''}:${name}`)
}
