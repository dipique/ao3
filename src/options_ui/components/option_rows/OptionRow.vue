<script setup lang="ts">
import type { options } from '#common'

import { rowSyncs } from '../../model/rowSync.ts'

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
   * Options the row edits that are read by a component around the row rather
   * than a control inside it, which names its own (`useRowOption`).
   */
  options?: readonly options.Id[]
}

const props = defineProps<OptionRowProps>()

const BADGES = {
  'needs-login': { label: 'Needs login', tip: 'Works only while you are logged in to AO3', warn: false },
  'this-device': { label: 'This device', tip: 'This device only - not synced', warn: false },
  'every-click': { label: 'Changes every click', tip: 'Overrides what happens when a link is clicked', warn: true },
} as const satisfies Record<RowBadge, { label: string, tip: string, warn: boolean }>

const { id, anchor, controlId, visible, titleHtml, subtitleHtml } = useSearchableRow(
  () => ({ title: props.title, subtitle: props.subtitle }),
)

const { isBookmarked, toggle } = useSettingBookmarks()
const bookmarked = computed({
  get: () => isBookmarked(anchor.value),
  set: () => toggle(anchor.value),
})

const edited = shallowReactive(new Set<options.Id>())
OptionRowEdits.provide(option => edited.add(option))
const { state: sync } = useSync()
/** Marked only while sync is on, since until then nothing syncs. */
const synced = computed(() => sync.enabled && rowSyncs([...(props.options ?? []), ...edited], props.badges))

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
    :class="{ 'option-row--master': master, 'option-row--inert': inert }"
    style="scroll-margin-top: var(--shell-top);"
  >
    <!-- The sync mark and bookmark stand outside the labels, so the title and description label the control without them. -->
    <div class="option-row__main">
      <span class="option-row__text">
        <span data-row-part="title" class="option-row__title">
          <label :for="controlId">
            <!-- v-html is safe here: `highlight` escapes the text and only ever adds <mark>. -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span v-html="titleHtml" />
            <template v-for="badge in badges" :key="badge">
              {{ ' ' }}<Badge :data-badge="badge" :warn="BADGES[badge].warn" :title="BADGES[badge].tip" ml="[3px]">{{ BADGES[badge].label }}</Badge>
            </template>
          </label>
          {{ ' ' }}<span class="option-row__marks">
            <Tooltip v-if="synced" content="Setting automatically syncs; settings without this icon apply to this browser only">
              <span data-synced class="option-row__synced i-tabler-refresh input-ring" role="img" aria-label="Syncs" tabindex="0" />
            </Tooltip>
            <IconToggle
              v-model="bookmarked"
              data-bookmark
              class="option-row__bookmark"
              label="Bookmark"
              :tip="bookmarked ? 'Remove from the sidebar' : 'Add to the sidebar'"
              :icon="bookmarked ? 'i-tabler-bookmark-filled' : 'i-tabler-bookmark'"
            />
          </span>
        </span>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <label v-show="!folded" :for="controlId" data-row-part="description" class="option-row__description" v-html="subtitleHtml" />
      </span>
      <div data-row-part="control" class="option-row__control" :title="reason ?? undefined">
        <slot :id="controlId" />
      </div>
    </div>
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
/* A master switch is drawn a size up from the switches it gates. */
@media (min-width: 768px) {
  .option-row--master :deep(.switch) {
    --switch-width: 40px;
    --switch-height: 22px;
    --thumb: 16px;
  }
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

/* The sync mark and bookmark follow the title as one unit, centred on each other. */
.option-row__marks {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  vertical-align: -2px;
}

.option-row__synced {
  border-radius: 3px;
  color: rgb(var(--color-muted-fg));
  font-size: 13px;
}

/* The bookmark is faint until the row is hovered, and lit while set. The rail
   lists bookmarks only from 768 px, so it shows there only. */
.option-row__title :deep(.option-row__bookmark) {
  display: none;
  width: 16px;
  height: 18px;
  border-width: 0;
  font-size: 14px;
}
@media (min-width: 768px) {
  .option-row__title :deep(.option-row__bookmark) {
    display: inline-grid;
  }
}
.option-row__title :deep(.option-row__bookmark:not(:hover)) {
  opacity: 0.35;
}
.option-row:hover .option-row__title :deep(.option-row__bookmark:not(:hover)) {
  opacity: 0.7;
}
.option-row__title :deep(.option-row__bookmark[aria-pressed='true']) {
  background-color: transparent;
  color: rgb(var(--color-brand-fg));
  opacity: 1;
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
   its buttons rather than squeezing the description to a word a line. Below
   1280 px the control column is only as wide as its control, since a 180 px
   one would leave a switch row's description a few words a line. */
@media (min-width: 1024px) {
  .option-row {
    display: grid;
    grid-template-columns: var(--row-title, 264px) minmax(10rem, 1fr) auto;
    grid-template-areas:
      'title description control'
      'extra extra extra';
    align-items: start;
    column-gap: 24px;
  }
  .option-row .option-row__main,
  .option-row .option-row__text {
    display: contents;
  }
  .option-row .option-row__title {
    grid-area: title;
  }
  .option-row .option-row__description {
    grid-area: description;
  }
  .option-row .option-row__control {
    grid-area: control;
    align-self: center;
    margin-left: 0;
  }
  .option-row .option-row__extra {
    grid-area: extra;
  }
}
@media (min-width: 1280px) {
  .option-row {
    grid-template-columns: var(--row-title, 264px) minmax(10rem, 1fr) minmax(180px, auto);
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
