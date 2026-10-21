<script setup lang="ts">
const { enabled } = useOption('searchLanguage')
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Default language"
    subtitle="Sets a default language in the Filter sidebar on search pages."
  >
    <label py-1 flex="~ row wrap items-center gap-2.5" text="[12.5px] muted-fg" leading="[18px]">
      <span>Default the language filter to</span>
      <OptionSearchLanguage />
    </label>
  </OptionRowCollapsable>
</template>
