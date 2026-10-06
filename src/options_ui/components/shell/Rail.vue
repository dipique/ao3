<script setup lang="ts">
const { rail } = useCurrentCategory()
const { categories } = useNav()
const { searching } = useOptionSearch()

/** Below 768 px the rail is a row of chips, which name the categories more briefly. */
const wide = useMediaQuery('(min-width: 768px)')

const items = computed(() => rail.value
  .filter(category => category.visible)
  .map((category) => {
    const nav = categories.value.find(c => c.id === category.id)
    return {
      ...category,
      label: (wide.value ? nav?.railLabel : nav?.chipLabel) ?? category.name,
      icon: nav?.icon ?? '',
      // While a query runs, only the sub-sections it has hits in.
      subsections: category.current ? category.subsections.filter(subsection => subsection.hits > 0) : [],
    }
  }))

const nav = ref<HTMLElement | null>(null)
const currentId = computed(() => items.value.find(item => item.current)?.id)

/**
 * The chip row scrolls sideways when its chips outgrow the window, so it brings
 * the current category's chip into view: the row is where a narrow window says
 * which category is showing. It scrolls the row alone, never the page, which
 * may be mid-way through a jump.
 */
watch([currentId, wide, nav], () => {
  const row = nav.value
  const chip = row?.querySelector<HTMLElement>('[data-rail-item][aria-current]')
  if (wide.value || !row || !chip)
    return
  const inset = Number.parseFloat(getComputedStyle(row).paddingLeft) || 0
  const bounds = row.getBoundingClientRect()
  const { left, right } = chip.getBoundingClientRect()
  if (left < bounds.left + inset)
    row.scrollLeft -= bounds.left + inset - left
  else if (right > bounds.right - inset)
    row.scrollLeft += right - (bounds.right - inset)
}, { flush: 'post', immediate: true })
</script>

<template>
  <nav
    ref="nav"
    data-rail
    aria-label="Settings sections"
    class="rail sticky top-12 z-40 h-11 flex items-center overflow-x-auto border-b-1 bg-card px-3 md:top-[52px] md:h-[calc(100vh-52px)] md:flex-col md:items-stretch md:overflow-x-hidden md:overflow-y-auto md:border-b-0 md:border-r-1 md:px-2.5 md:py-3"
  >
    <ul class="flex gap-[7px] md:flex-col md:gap-px">
      <li v-for="item in items" :key="item.id" shrink-0>
        <a
          data-rail-item="category"
          :href="`#${item.id}`"
          :aria-current="item.current ? 'true' : undefined"
          class="h-[30px] flex items-center gap-1.5 whitespace-nowrap border-1 rounded-full px-3 text-[13px] decoration-none input-ring md:h-8 md:gap-2.5 md:border-transparent md:rounded-[7px] md:px-2.5"
          :class="item.current
            ? 'border-brand-fg/32 bg-brand-fg/10 text-brand-fg font-600'
            : 'border-border bg-default text-muted-fg md:bg-transparent md:text-default-fg md:hover:bg-default-fg/3'"
        >
          <span class="hidden md:inline-flex" aria-hidden="true"><span :class="item.icon" text-base /></span>
          <span data-rail-label>{{ item.label }}</span>
          <span v-if="searching" data-rail-count ml-auto text="[10.5px]" font-400 tabular-nums>{{ item.hits }}</span>
        </a>
        <ul
          v-if="item.subsections.length"
          class="hidden md:flex"
          border="l-1" ml="[21px]" mb-1.5 mt-0.5 flex-col gap-px pl="[11px]"
        >
          <li v-for="subsection in item.subsections" :key="subsection.id">
            <a
              data-rail-item="subsection"
              :href="`#${subsection.id}`"
              class="h-[26px] flex items-center justify-between gap-2 rounded-md px-2 text-xs text-muted-fg decoration-none input-ring hover:bg-default-fg/3 hover:text-default-fg"
            >
              <span data-rail-label truncate>{{ subsection.name }}</span>
              <span data-rail-count text="[10.5px]" tabular-nums>{{ subsection.hits }}</span>
            </a>
          </li>
        </ul>
      </li>
    </ul>
    <div class="hidden md:block" mt-auto border="t-1" px-2.5 pb-0.5 pt-2.5>
      <PageFoot />
    </div>
  </nav>
</template>

<style scoped>
@media (max-width: 767.98px) {
  .rail {
    scrollbar-width: none;
  }
  .rail::-webkit-scrollbar {
    display: none;
  }
}
</style>
