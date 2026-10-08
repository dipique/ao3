<script setup lang="ts">
import { holdForLink } from '../../composables/useSubsectionInView.ts'
import { railJob } from '../../model/jobView.ts'

const { rail } = useCurrentCategory()
const { categories } = useNav()
const { searching } = useOptionSearch()
const { view } = useSiteExport()

/** A running job, shown on the category holding the lists it runs on, so it is in sight from any category. */
const job = computed(() => railJob(view.value))

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
      jobs: !!nav?.jobs,
      subsections: category.current ? category.subsections.filter(subsection => subsection.visible) : [],
    }
  }))

const nav = ref<HTMLElement | null>(null)
const current = computed(() => items.value.find(item => item.current))
const currentId = computed(() => current.value?.id)

/**
 * The current category's sub-section being read, marked as the page scrolls.
 * The chip row lists no sub-sections, so nothing is marked on a narrow window.
 */
const inView = useSubsectionInView(computed(() => current.value?.subsections.map(subsection => subsection.id) ?? []), wide)

/**
 * The chip row scrolls sideways when its chips outgrow the window, so it brings
 * the current category's chip into view: the row is where a narrow window says
 * which category is showing. It scrolls the row alone, never the page, which
 * may be mid-way through a jump.
 */
watch([currentId, wide, nav], () => {
  const row = nav.value
  const chip = row?.querySelector<HTMLElement>('[data-rail-item="category"][aria-current]')
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
          class="touch-target h-[30px] flex items-center gap-1.5 whitespace-nowrap border-1 rounded-full px-3 text-[13px] decoration-none input-ring md:h-8 md:gap-2.5 md:border-transparent md:rounded-[7px] md:px-2.5"
          :class="item.current
            ? 'border-brand-fg/32 bg-brand-fg/10 text-brand-fg font-600'
            : 'border-border bg-default text-muted-fg md:bg-transparent md:text-default-fg md:hover:bg-default-fg/3'"
          @click="holdForLink($event, `#${item.id}`)"
        >
          <span class="hidden md:inline-flex" aria-hidden="true"><span :class="item.icon" text-base /></span>
          <span data-rail-label>{{ item.label }}</span>
          <span
            v-if="item.jobs && job"
            data-rail-job
            :title="job.title"
            class="inline-flex items-center gap-1 text-[10.5px] text-brand-fg font-600 tabular-nums md:ml-auto"
          >
            <span class="i-tabler-loader-2 motion-safe:animate-spin" aria-hidden="true" />
            <span class="sr-only">{{ job.title }}</span>
            <span aria-hidden="true">{{ job.text }}</span>
          </span>
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
              :aria-current="subsection.id === inView ? 'location' : undefined"
              class="h-[26px] flex items-center justify-between gap-2 rounded-md px-2 text-xs decoration-none input-ring hover:bg-default-fg/3 hover:text-default-fg"
              :class="subsection.id === inView ? 'bg-default-fg/3 text-default-fg' : 'text-muted-fg'"
              @click="holdForLink($event, `#${subsection.id}`)"
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
