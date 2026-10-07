<script setup lang="ts">
const { chosen } = useOption('theme')

const id = OptionLabelId.inject()
</script>

<template>
  <RadioBox :id="id" v-model="chosen">
    <RadioBoxItem value="inherit" label="Use theme from AO3">
      <Icon i-ao3e-ao3 text="[14px]" />AO3
    </RadioBoxItem>
    <RadioBoxItem value="light" label="Always use light theme">
      Light
    </RadioBoxItem>
    <RadioBoxItem value="dark" label="Always use dark theme">
      Dark
    </RadioBoxItem>
  </RadioBox>
</template>
