<script setup lang="ts">
export interface OptionRowProps {
  title: string
  subtitle: string
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
      :for="controlId"
      :class="roomy ? 'min-h-10' : 'min-h-7'"
      grid="~ cols-[1fr_min-content] items-center"
    >
      <div flex="~ col" mr-4>
        <!-- v-html is safe here: `highlight` escapes the text and only ever adds <mark>. -->
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
