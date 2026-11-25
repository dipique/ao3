<script setup lang="ts">
const optionValue = useRowOption('opportunisticCache')
const id = OptionLabelId.inject()
</script>

<template>
  <Select
    :id="id"
    v-model="optionValue"
    size="row"
  >
    <SelectItem :value="null">
      <span text="muted-fg">Disabled</span>
    </SelectItem>
    <SelectItem value="markedForLater">
      Marked for Later
    </SelectItem>
    <SelectItem value="tracked">
      All tracked lists
    </SelectItem>
  </Select>
</template>
