<script setup lang="ts">
export interface OptionRowProps {
  title: string
  subtitle: string
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

const { id, controlId, visible, showDescriptions, searching, titleHtml, subtitleHtml } = useSearchableRow(
  () => ({ title: props.title, subtitle: props.subtitle }),
)

/**
 * With descriptions hidden a row is one line of text, but the padding and the
 * label's minimum height were still sized for two — so the list stayed as tall as
 * it was and the switch bought nothing. Tighten both when there is nothing under
 * the title. Class strings are spelled out rather than interpolated so UnoCSS's
 * extractor can see them.
 */
const roomy = computed(() => showDescriptions.value || searching.value)

OptionLabelId.provide(controlId)
</script>

<template>
  <div
    v-show="visible"
    :id="id"
    :class="roomy ? 'py-2' : 'py-1'"
    flex="~ col justify-center"
    style="scroll-margin-top: calc(var(--header-height, 0px) + var(--toolbar-height, 0px));"
  >
    <label
      v-if="stacked"
      :for="controlId"
      flex="~ col gap-1"
    >
      <span font="leading-none 400" text="base">
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
        <span v-if="roomy" text="sm muted-fg" v-html="subtitleHtml" />
        <span v-else />
        <div flex="~ row items-center justify-end" w-full>
          <slot :id="controlId" />
        </div>
      </div>
    </label>
    <label
      v-else
      :for="controlId"
      :class="roomy ? 'min-h-10' : 'min-h-7'"
      grid="~ cols-[1fr_min-content] items-center"
    >
      <div flex="~ col" mr-4>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span font="leading-none 400" text="base" v-html="titleHtml" />
        <!-- Descriptions can be switched off once they've been read, but a search
             still shows them: the hit is often in the description, and hiding it
             would leave the row looking like it matched nothing. -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span v-if="roomy" text="sm muted-fg" v-html="subtitleHtml" />
      </div>
      <div flex="~ col justify-center items-center" h-full w-full>
        <slot :id="controlId" />
      </div>
    </label>
    <slot :id="controlId" name="extra" />
  </div>
</template>
