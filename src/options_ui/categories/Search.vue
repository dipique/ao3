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
      title="Tag include/exclude toolbar"
      subtitle="Show include (+) and exclude (−) buttons when hovering a tag on a works listing, to add it to (or remove it from) the filter. Uses the existing sidebar checkbox when there is one."
    >
      <OptionSwitch option-id="tagToolbar" />
    </OptionRow>
  </OptionCategory>
</template>
