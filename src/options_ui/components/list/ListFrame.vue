<script setup lang="ts">
import type { ListCap } from '../../model/listView.ts'

import { capFor } from '../../model/listView.ts'

/**
 * The frame an editable list is drawn in: a header for what acts on the list
 * as a whole — its title (or a filter in the title's place), its count, a sort,
 * Add — over a body of `ListRow`s, or over the empty state in their place. The
 * header holds still whatever the body does, so nothing moves when the first
 * row lands.
 *
 * The body is exactly as tall as its rows until there are more than its cap,
 * then holds that many and scrolls the rest ({@link capFor}). Room for the
 * scrollbar is kept from the start, so no row shifts when the list starts to
 * scroll, and a shadow shows at an edge only while there is more past it.
 *
 * The rows are the default slot's direct children, since the cap measures
 * them.
 */
const props = withDefaults(defineProps<{
  /** The list's `data-list`. */
  listId: string
  /** The list's accessible name, drawn in the header unless a filter takes its place. */
  title: string
  /** The header's count, as it should read. */
  count: string
  /** Show the empty state in place of the rows. */
  empty?: boolean
  cap?: ListCap
  /** The header's Add button's name; without one there is no Add button. */
  addLabel?: string
}>(), { cap: 'setting' })

/** Add was pressed: the click, whose `currentTarget` is the button, for a dialog to give focus back to. */
const emit = defineEmits<{ add: [event: MouseEvent] }>()

const titleId = useId()

const rows = useTemplateRef<HTMLElement>('rows')
const held = ref<number | null>(null)

function measure() {
  const list = rows.value
  // Not laid out, so every height would read 0.
  if (!list?.offsetHeight)
    return
  held.value = capFor(props.cap, [...list.children].map(row => row.getBoundingClientRect().height))
}

// The observer catches a row changing height and the frame being shown or
// narrowed, but reports only as the page is about to paint: after code
// awaiting the render has run. Measuring on each update as well caps the body
// before then, so a row just added past the cap is scrolled to where the
// capped body shows it.
useResizeObserver(rows, measure)
onUpdated(measure)

/**
 * Bring the row with this `data-list-row` into sight, scrolling the body and
 * the page no more than it takes, and focus its first field: for a row just
 * added, which lands past what a capped body shows. Call it once the row is
 * rendered.
 */
function reveal(rowId: string | number) {
  const row = rows.value?.querySelector<HTMLElement>(`[data-list-row="${CSS.escape(String(rowId))}"]`)
  row?.scrollIntoView({ block: 'nearest' })
  row?.querySelector('input')?.focus({ preventScroll: true })
}

defineExpose({ reveal })
</script>

<template>
  <div role="group" :aria-labelledby="titleId" :data-list="listId" class="list-frame">
    <div class="list-frame__head">
      <span :id="titleId" class="list-frame__title" :class="{ 'sr-only': $slots.filter }">{{ title }}</span>
      <slot name="filter" />
      <span data-list-count class="list-frame__count">{{ count }}</span>
      <slot name="controls" />
      <button
        v-if="addLabel"
        type="button"
        class="icon-btn"
        :aria-label="addLabel"
        :title="addLabel"
        @click="emit('add', $event)"
      >
        <span class="i-tabler-plus" text="[15px]" aria-hidden="true" />
      </button>
    </div>
    <div v-if="empty" class="list-frame__empty">
      <slot name="empty" />
    </div>
    <div
      v-else
      data-list-body
      class="list-frame__body"
      :style="{ maxHeight: held === null ? undefined : `${held}px` }"
    >
      <div ref="rows" role="list">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* A row lays itself out by the frame's width rather than the window's, since
   the same list can span a wide pane or sit in a narrow column. */
.list-frame {
  container-type: inline-size;
  overflow: hidden;
  border: 1px solid rgb(var(--color-border));
  border-radius: 9px;
  background-color: rgb(var(--color-default));
}

.list-frame__head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid rgb(var(--color-border));
  background-color: rgb(var(--color-muted));
}
/* The header's words are the text colour at 57%: muted-fg's shade in dark and
   a touch darker in light, which reads at AA (4.5:1) on `muted` in both. */
.list-frame__title {
  color: rgb(var(--color-default-fg) / 0.57);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.list-frame__count {
  margin-left: auto;
  color: rgb(var(--color-default-fg) / 0.57);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.list-frame__empty {
  padding: 26px 16px;
  color: rgb(var(--color-muted-fg));
  font-size: 12.5px;
  line-height: 18px;
  text-align: center;
}
.list-frame__empty :slotted(b) {
  display: block;
  margin-bottom: 4px;
  color: rgb(var(--color-default-fg));
  font-weight: 600;
}

/*
  The shadows: two shades fixed to the body's edges (`scroll`), under two
  covers in the ground colour that travel with the rows (`local`). At the top
  of the rows the top cover hides the top shade, and at their end the bottom
  cover hides the bottom one; anywhere between, both shades show.
*/
.list-frame__body {
  overflow-y: auto;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--scroll-thumb) transparent;
  background:
    linear-gradient(rgb(var(--color-default)) 30%, rgb(var(--color-default) / 0)) top / 100% 26px no-repeat local,
    linear-gradient(rgb(var(--color-default) / 0), rgb(var(--color-default)) 70%) bottom / 100% 26px no-repeat local,
    radial-gradient(farthest-side at 50% 0, var(--scroll-shade), transparent) top / 100% 11px no-repeat scroll,
    radial-gradient(farthest-side at 50% 100%, var(--scroll-shade), transparent) bottom / 100% 11px no-repeat scroll;
  background-color: rgb(var(--color-default));
}
.list-frame__body:hover {
  scrollbar-color: var(--scroll-thumb-hover) transparent;
}
</style>
