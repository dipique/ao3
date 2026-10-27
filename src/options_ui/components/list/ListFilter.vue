<script setup lang="ts">
/**
 * A list's filter, for its frame's header, in the title's place: a field for
 * the text to find, and a button that empties it while it holds any. Which
 * rows the text keeps is the list's own business.
 */
defineProps<{
  /** The field's accessible name. */
  label: string
  placeholder: string
  /** The clear button's name. */
  clearLabel: string
}>()

const query = defineModel<string>({ required: true })

const field = useTemplateRef<HTMLInputElement>('field')

/** The button goes as the field empties, so the focus goes to the field rather than to nowhere. */
function clear() {
  query.value = ''
  field.value?.focus()
}
</script>

<template>
  <div class="list-filter">
    <span class="i-tabler-search shrink-0 text-[12px]" aria-hidden="true" />
    <input
      ref="field"
      v-model="query"
      type="text"
      :aria-label="label"
      :placeholder="placeholder"
      data-list-filter
      autocomplete="off"
      spellcheck="false"
      class="list-filter__field"
    >
    <button
      v-if="query"
      type="button"
      class="list-filter__clear icon-btn"
      :aria-label="clearLabel"
      :title="clearLabel"
      data-action="clear"
      @click="clear"
    >
      <span class="i-tabler-x" text="[12px]" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.list-filter {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 260px;
  height: 24px;
  padding: 0 2px 0 8px;
  border: 1px solid rgb(var(--color-input));
  border-radius: 6px;
  background-color: rgb(var(--color-default));
  color: rgb(var(--color-muted-fg));
}
.list-filter:focus-within {
  box-shadow: 0 0 0 3px rgb(var(--color-ring) / 0.5);
}
.list-filter__field {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: rgb(var(--color-default-fg));
  font-size: 12px;
}
.list-filter__field::placeholder {
  color: rgb(var(--color-muted-fg));
}
.list-filter__clear {
  width: 18px;
  height: 18px;
}
</style>
