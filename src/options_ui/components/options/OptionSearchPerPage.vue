<script setup lang="ts">
const optionValue = useOption('searchPerPage')
const id = OptionLabelId.inject()
const choices = [25, 50, 100, 250, 1000]
</script>

<template>
  <Select
    :id="id"
    v-model="optionValue"
    h-8 w-40
  >
    <SelectItem
      v-for="n in choices"
      :key="n"
      :value="n"
    >
      {{ n }} per page
    </SelectItem>
  </Select>
</template>
