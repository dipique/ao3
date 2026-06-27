<script setup lang="ts">
const modelValue = defineModel<string>({ required: true })

// A native <input type="color"> only understands #rrggbb — it has no alpha
// channel. So the swatch shows just the RGB part of an #rrggbbaa colour, and we
// re-attach the existing alpha suffix when a new hue is picked from it. The text
// field carries the full value (alpha included) for users who want to fine-tune.
const isHex8 = (c: string) => /^#[0-9a-f]{8}$/i.test(c)
const swatch = computed({
  get: () => (isHex8(modelValue.value) ? modelValue.value.slice(0, 7) : modelValue.value),
  set: (v: string) => {
    modelValue.value = isHex8(modelValue.value) ? v + modelValue.value.slice(7) : v
  },
})
</script>

<template>
  <div flex="~ items-center gap-2">
    <input
      v-model="swatch"
      type="color"
      h-9 w-12 cursor-pointer border rounded-md bg-transparent p-1
    >
    <Input
      v-model="modelValue"
      type="text"
      text="base" h-10 w-32 py-2 pl-2
    />
    <slot />
  </div>
</template>
