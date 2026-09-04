<script setup lang="ts">
const { enabled } = useOption('searchLanguage')
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Default language"
    subtitle="Pre-selects a language in the Sort &amp; Filter sidebar on works and bookmark listings, and on the advanced search page."
  >
    <label py-1 flex="~ row items-center gap-1">
      <span font="leading-none" text="sm muted-fg">Default the language filter to</span>
      <OptionSearchLanguage />
    </label>
  </OptionRowCollapsable>
</template>
