<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Search &amp; browsing"
    subtitle="Tweaks for the works filter/search pages."
  >
    <template #icon>
      <Icon i-mdi-magnify />
    </template>
    <OptionRow
      title="Compress filter URLs"
      subtitle="Shorten the URL produced by the Sort &amp; Filter sidebar so heavy filters stay under AO3's length limit. Results are unchanged."
    >
      <OptionSwitch option-id="compressSearchUrls" />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Tag exclude toolbar"
      subtitle="Show a button when hovering a tag on a works listing to add it to (or remove it from) the &quot;Other tags to exclude&quot; filter."
    >
      <OptionSwitch option-id="tagToolbar" />
    </OptionRow>
  </OptionCategory>
</template>
