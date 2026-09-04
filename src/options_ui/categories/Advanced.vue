<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Advanced"
    subtitle="Settings most people never need to touch, and tools for moving your data around."
  >
    <template #icon>
      <Icon i-mdi-alert-decagram-outline />
    </template>
    <OptionRow
      title="Compress filter URLs"
      subtitle="Shortens the URL the Sort &amp; Filter sidebar produces, so a heavy set of filters stays under AO3's length limit. Your results are unchanged."
    >
      <OptionSwitch option-id="compressSearchUrls" />
    </OptionRow>
    <OptionDivider />
    <OptionRowFandomExport />
    <OptionDivider />
    <OptionRowImportExport />
    <OptionDivider />
    <OptionRow
      title="Debug mode"
      subtitle="Logs what the extension is doing to the browser's developer console. Useful when reporting a problem."
    >
      <OptionSwitch option-id="verbose" />
    </OptionRow>
  </OptionCategory>
</template>
