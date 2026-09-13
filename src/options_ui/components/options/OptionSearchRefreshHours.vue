<script setup lang="ts">
const optionValue = useOption('searchProfileListsRefreshHours')
const id = OptionLabelId.inject()
const choices: { hours: number, label: string }[] = [
  { hours: 0, label: 'Every time' },
  { hours: 1, label: 'After 1 hour' },
  { hours: 6, label: 'After 6 hours' },
  { hours: 12, label: 'After 12 hours' },
  { hours: 24, label: 'After 1 day' },
  { hours: 72, label: 'After 3 days' },
  { hours: 168, label: 'After 1 week' },
]
</script>

<template>
  <Select
    :id="id"
    v-model="optionValue"
    h-8 w-40
  >
    <SelectItem
      v-for="choice in choices"
      :key="choice.hours"
      :value="choice.hours"
    >
      {{ choice.label }}
    </SelectItem>
  </Select>
</template>
