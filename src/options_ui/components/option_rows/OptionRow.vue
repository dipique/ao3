<script setup lang="ts">
/** A fact about a setting, shown as a badge beside its title. */
export type RowBadge = 'needs-login' | 'this-device' | 'every-click'

export interface OptionRowProps {
  title: string
  subtitle: string
  /** Facts that would otherwise be a phrase in the description. */
  badges?: readonly RowBadge[]
  /**
   * The switch heading an `OptionMasterGroup`: it gates the rows under it
   * rather than being gated, and its title carries the weight.
   */
  master?: boolean
  /**
   * Give the title a line of its own, with the description and the controls
   * side by side beneath it.
   *
   * For rows whose title is data rather than a label — a stored list's name,
   * which can be as long as a tag — and whose controls are wide enough that
   * sharing a line would wrap the title after two words. Laid out this way the
   * title only breaks when it is longer than the whole row.
   */
  stacked?: boolean
  /**
   * Width of the control column, as a CSS length. Only meaningful with
   * {@link stacked}, and only worth setting on a list of sibling rows: `auto`
   * sizes each row's controls to its own contents, so rows with different
   * buttons end up with their descriptions starting at different places and the
   * widest row's buttons pushed off the edge. A fixed column lines them up.
   */
  controlWidth?: string
}

const props = defineProps<OptionRowProps>()

const BADGES = {
  'needs-login': { label: 'Needs login', tip: 'Works only while you are logged in to AO3', warn: false },
  'this-device': { label: 'This device', tip: 'What it remembers stays on this device, and sync doesn\'t carry it', warn: false },
  'every-click': { label: 'Changes every click', tip: 'Changes what a plain click on a link does', warn: true },
} as const satisfies Record<RowBadge, { label: string, tip: string, warn: boolean }>

const { id, controlId, visible, titleHtml, subtitleHtml } = useSearchableRow(
  () => ({ title: props.title, subtitle: props.subtitle }),
)

OptionLabelId.provide(controlId)

const group = props.master ? null : OptionMasterState.inject(null)
const inert = computed(() => group?.value.inert ?? false)
const folded = computed(() => group?.value.folded ?? false)
const reason = computed(() => group?.value.reason ?? null)
const reasonId = `${controlId}-reason`
OptionRowOff.provide({ reason, id: reasonId })
</script>

<template>
  <div
    v-show="visible"
    :id="id"
    class="option-row"
    :class="{ 'option-row--grid': !stacked, 'option-row--master': master, 'option-row--inert': inert }"
    style="scroll-margin-top: var(--shell-top);"
  >
    <label
      v-if="stacked"
      :for="controlId"
      flex="~ col gap-1"
    >
      <span data-row-part="title" class="option-row__title">
        <!-- v-html is safe here: `highlight` escapes the text and only ever adds <mark>. -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span v-html="titleHtml" />{{ ' ' }}<!--
          Inline rather than a flex child, so a title long enough to wrap takes
          this with it instead of stranding it on a line of its own.
        --><slot name="title-suffix" />
      </span>
      <div
        :style="{ gridTemplateColumns: `minmax(0, 1fr) ${controlWidth ?? 'auto'}` }"
        grid="~ items-center gap-4"
      >
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span data-row-part="description" class="option-row__description" v-html="subtitleHtml" />
        <div data-row-part="control" flex="~ row items-center justify-end" w-full>
          <slot :id="controlId" />
        </div>
      </div>
    </label>
    <label v-else :for="controlId" class="option-row__main">
      <span class="option-row__text">
        <span data-row-part="title" class="option-row__title">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-html="titleHtml" />
          <template v-for="badge in badges" :key="badge">
            {{ ' ' }}<Badge :data-badge="badge" :warn="BADGES[badge].warn" :title="BADGES[badge].tip" ml="[3px]">{{ BADGES[badge].label }}</Badge>
          </template>
        </span>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span v-show="!folded" data-row-part="description" class="option-row__description" v-html="subtitleHtml" />
      </span>
      <div data-row-part="control" class="option-row__control" :title="reason ?? undefined">
        <slot :id="controlId" />
      </div>
    </label>
    <span v-if="reason" :id="reasonId" hidden>{{ reason }}</span>
    <div v-if="$slots.extra" class="option-row__extra">
      <slot :id="controlId" name="extra" />
    </div>
  </div>
</template>

<style scoped>
/*
  From 1024 px the title, description and control sit side by side in a grid,
  the titles forming one column to scan down. Narrower, the description goes
  under the title and the control beside both, unless that would leave the text
  under 13rem: then the control drops beneath it. What the row reveals spans
  the whole row below.

  The row reaches 10 px past the pane on either side, with as much padding, so
  its hover tint has room round the text while the text stays in line with the
  headings.
*/
.option-row {
  margin: 0 -10px;
  padding: 10px;
  border-top: 1px solid rgb(var(--color-hair));
  border-radius: 7px;
}
.option-row:hover {
  background-color: rgb(var(--color-default-fg) / 0.03);
}
.option-row--master {
  border-top-width: 0;
}

.option-row__main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}
.option-row__text {
  display: flex;
  flex: 1 1 13rem;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.option-row__control {
  display: flex;
  flex: none;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  margin-left: auto;
}
.option-row__extra {
  min-width: 0;
}

.option-row__title {
  font-size: 14px;
  line-height: 19px;
}
.option-row--master .option-row__title {
  font-weight: 600;
}
.option-row__description {
  color: rgb(var(--color-muted-fg));
  font-size: 12.5px;
  line-height: 17px;
}

@media (min-width: 768px) {
  .option-row {
    padding: 11px 10px;
  }
  .option-row__main {
    column-gap: 24px;
  }
  .option-row__title {
    padding-top: 1px;
    font-size: 13.5px;
    line-height: 18px;
  }
  .option-row__description {
    font-size: 12px;
  }
}

/* `--row-title` narrows the title column inside an indented group, so the
   group's descriptions and controls line up with the rows outside it. The
   description keeps at least 10rem: a control wider than what is left wraps
   its buttons rather than squeezing the description to a word a line. */
@media (min-width: 1024px) {
  .option-row--grid {
    display: grid;
    grid-template-columns: var(--row-title, 264px) minmax(10rem, 1fr) minmax(180px, auto);
    grid-template-areas:
      'title description control'
      'extra extra extra';
    align-items: start;
    column-gap: 24px;
  }
  .option-row--grid .option-row__main,
  .option-row--grid .option-row__text {
    display: contents;
  }
  .option-row--grid .option-row__title {
    grid-area: title;
  }
  .option-row--grid .option-row__description {
    grid-area: description;
  }
  .option-row--grid .option-row__control {
    grid-area: control;
    align-self: center;
    margin-left: 0;
  }
  .option-row--grid .option-row__extra {
    grid-area: extra;
  }
}

/* Gated by a master switch that is off: a compact, greyed list of titles. */
.option-row.option-row--inert {
  padding-top: 6px;
  padding-bottom: 6px;
  opacity: 0.48;
}
.option-row.option-row--inert:hover {
  background-color: transparent;
}
/* The row is greyed already, so its control isn't dimmed a second time. */
.option-row--inert :deep([role='switch']:disabled) {
  opacity: 1;
}
@media (min-width: 768px) {
  .option-row--inert .option-row__title {
    font-size: 12.5px;
  }
}
</style>
