<script setup lang="ts">
/**
 * One row of a `ListFrame`: 32 px, parted from the row above by a hair line,
 * tinted while hovered. Its parts are slots, each in the grid area of its name:
 *
 * - `order`: what moves the row through a list the reader keeps in order;
 * - `icon`: a glyph saying what the row does or is;
 * - `numbers`: a priority, a count;
 * - `identity` (the default slot): what the row is, given the width left over
 *   and ellipsed rather than wrapped;
 * - `meta`: a line about it, or `error` in its place;
 * - `actions`.
 *
 * A glyph among the words in `numbers`, `identity` or `meta` takes the class
 * `list-row__glyph`, so it fades with the row's other glyphs while the row is
 * off.
 *
 * `template` lays them out, as a CSS `grid-template` over those names, and
 * `narrowTemplate` while the frame is 440 px wide or less, where `meta` may
 * take a line of its own and wraps.
 */
defineProps<{
  /** The row's `data-list-row`. */
  rowId: string | number
  template: string
  narrowTemplate?: string
  /** Why the row can't be saved, shown in place of `meta`. */
  error?: string | null
  /**
   * A row that is switched off, such as a disabled rule: its glyphs and
   * controls drop to 48%, and its words to the text colour at 57%.
   */
  off?: boolean
  /**
   * `identity` holds a control beside words that ellipse themselves, such as
   * a name and its Rename: the cell leaves the control's hit area whole
   * rather than clipping for an ellipsis, and the list's first row keeps room
   * above that line for it where the narrow layout puts the line at the top.
   */
  identityControls?: boolean
}>()
</script>

<template>
  <div
    role="listitem"
    :data-list-row="rowId"
    class="list-row"
    :class="{
      'list-row--off': off,
      'list-row--narrowable': !!narrowTemplate,
      'list-row--ordered': !!$slots.order,
      'list-row--identity-controls': identityControls,
    }"
    :style="{ '--row-template': template, '--row-template-narrow': narrowTemplate }"
  >
    <div v-if="$slots.order" class="list-row__order">
      <slot name="order" />
    </div>
    <div v-if="$slots.icon" class="list-row__icon">
      <slot name="icon" />
    </div>
    <div v-if="$slots.numbers" class="list-row__numbers">
      <slot name="numbers" />
    </div>
    <div class="list-row__identity">
      <slot />
    </div>
    <div v-if="error" data-list-error class="list-row__meta list-row__meta--error">
      <SeverityGlyph severity="destructive" class="list-row__glyph mt-px shrink-0 text-[13px]" />
      <span>{{ error }}</span>
    </div>
    <div v-else-if="$slots.meta" data-list-meta class="list-row__meta">
      <slot name="meta" />
    </div>
    <div v-if="$slots.actions" class="list-row__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.list-row {
  display: grid;
  grid-template: var(--row-template);
  align-items: center;
  gap: 4px 8px;
  min-height: 32px;
  padding: 3px 4px 3px 6px;
  border-top: 1px solid rgb(var(--color-hair));
  font-size: 12.5px;
  line-height: 16px;
}
.list-row:first-child {
  border-top-width: 0;
}
.list-row:hover {
  background-color: var(--row-hover);
}
/* Switched off, the row stands back from the rows that act: its glyphs and
   controls fade to 48%, and its words, still there to be read, are the text
   colour at 57%, which reads at AA where 48% would not. */
.list-row--off :is(.list-row__order, .list-row__icon, .list-row__actions),
.list-row--off :is(.list-row__numbers, .list-row__identity, .list-row__meta) :deep(.list-row__glyph) {
  opacity: 0.48;
}
.list-row--off :is(.list-row__numbers, .list-row__identity, .list-row__meta),
.list-row--off
  :is(.list-row__numbers, .list-row__identity, .list-row__meta)
  :deep(:not(.list-row__glyph, .list-row__glyph *)) {
  color: rgb(var(--color-default-fg) / 0.57);
}

.list-row__order {
  display: flex;
  grid-area: order;
  justify-content: center;
  color: rgb(var(--color-muted-fg));
}
.list-row__icon {
  display: grid;
  grid-area: icon;
  place-items: center;
  color: rgb(var(--color-muted-fg));
}
.list-row__numbers {
  grid-area: numbers;
  color: rgb(var(--color-muted-fg));
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
/* Clipped to ellipse its text, with 3 px of room inside the clip so a focus
   ring on a field in it is drawn whole. */
.list-row__identity {
  grid-area: identity;
  min-width: 0;
  margin: -3px;
  padding: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.list-row--identity-controls .list-row__identity {
  overflow: visible;
}
.list-row__meta {
  grid-area: meta;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* An error is read whole, never ellipsed, in the text colour beside its
   glyph. */
.list-row__meta--error {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  color: rgb(var(--color-default-fg));
  white-space: normal;
}
.list-row__actions {
  display: flex;
  grid-area: actions;
  justify-content: flex-end;
  gap: 1px;
}

/* Below 768 px, where it is touched, 48 px tall, so a button's hit area stays
   inside its row. The frame's body scrolls, so it cuts off whatever reaches
   past its edges: a row starting with its order buttons keeps room before the
   first for its hit area. */
@media (max-width: 767.98px) {
  .list-row {
    min-height: 48px;
  }
  .list-row--ordered {
    padding-left: 10px;
  }
}

@container (max-width: 440px) {
  .list-row--narrowable {
    grid-template: var(--row-template-narrow);
    padding-top: 5px;
    padding-bottom: 6px;
  }
  .list-row--narrowable .list-row__meta {
    white-space: normal;
  }
}

/* Narrow and touched, the controls beside a row's identity sit on its first
   line rather than across the whole row, so the first row keeps room above
   them for their hit areas inside the body. */
@media (max-width: 767.98px) {
  @container (max-width: 440px) {
    .list-row--narrowable.list-row--identity-controls:first-child {
      padding-top: 10px;
    }
  }
}
</style>
