<script setup lang="ts">
const optionValue = useOption('hideShowReason')
const id = OptionLabelId.inject()

const value = computed({
  get: () => optionValue.value ? 'true' : 'false',
  set: (value: string) => optionValue.value = value === 'true',
})
</script>

<template>
  <RadioBox :id="id" v-model="value">
    <RadioBoxItem value="true" label="Collapse the work to a line saying why, with a button to show it">
      Collapse
    </RadioBoxItem>
    <RadioBoxItem value="false" label="Take the work out of the listing entirely">
      Hide fully
    </RadioBoxItem>
  </RadioBox>
</template>
