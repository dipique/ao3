<script setup lang="ts">
const optionValue = useOption('hideShowReason')
const id = OptionLabelId.inject()

const value = computed({
  get: () => optionValue.value ? 'true' : 'false',
  set: (value: string) => optionValue.value = value === 'true',
})

const [DefineBox, Box] = createReusableTemplate<{ value: string, label: string }>()
</script>

<template>
  <DefineBox v-slot="{ $slots, value, label }">
    <RadioBoxItem
      :value="value"
      :label="label"
      h-12
      text="xs"
    >
      <span px-3>
        <component :is="$slots.default" />
      </span>
    </RadioBoxItem>
  </DefineBox>
  <RadioBox
    :id="id"
    v-model="value"
    grid="~ grid-cols-[1fr] gap-2 sm:cols-[repeat(2,50%)]"
  >
    <Box
      value="true"
      label="Collapse the work to a line saying why, with a button to show it"
    >
      <span>Collapse</span>
    </Box>
    <Box
      value="false"
      label="Take the work out of the listing entirely"
    >
      <span>Hide fully</span>
    </Box>
  </RadioBox>
</template>
