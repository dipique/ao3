<script setup lang="ts">
const optionValue = useOption('searchMaxResults')
const id = OptionLabelId.inject()
const choices = [200, 500, 1000, 2500, 5000, 10000]
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
      {{ n.toLocaleString() }} works
    </SelectItem>
  </Select>
</template>
