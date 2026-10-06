<script setup lang="ts">
/**
 * One field of a dialog laid out in sections: its label in a column of its
 * own beside the control, and a line of help under the control, which the
 * default slot's `helpId` names for an `aria-describedby`. In a dialog
 * narrower than 480 px the label goes above the control.
 *
 * `labelFor` makes the label a `<label>` for that control. A group of choices
 * is no one control, and names itself.
 */
defineProps<{
  label: string
  labelFor?: string
}>()

const helpId = useId()
</script>

<template>
  <div class="dialog-field">
    <label v-if="labelFor" :for="labelFor" class="dialog-field__label">{{ label }}</label>
    <span v-else class="dialog-field__label">{{ label }}</span>
    <div class="dialog-field__control">
      <slot :help-id="$slots.help ? helpId : undefined" />
    </div>
    <div v-if="$slots.help" :id="helpId" class="dialog-field__help">
      <slot name="help" />
    </div>
  </div>
</template>

<style scoped>
.dialog-field {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 6px 16px;
  align-items: start;
  padding: 12px 0;
  border-top: 1px solid rgb(var(--color-hair));
}
.dialog-field:first-child {
  border-top: none;
}
.dialog-field__label {
  padding-top: 6px;
  font-size: 12px;
  font-weight: 600;
}
.dialog-field__control {
  min-width: 0;
}
.dialog-field__help {
  grid-column: 2;
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
  line-height: 16px;
}
@container (max-width: 480px) {
  .dialog-field {
    grid-template-columns: minmax(0, 1fr);
  }
  .dialog-field__label {
    padding-top: 0;
  }
  .dialog-field__help {
    grid-column: 1;
  }
}
</style>
