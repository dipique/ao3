<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Advanced"
    subtitle="Your data, and settings most people never need to touch."
    icon="i-mdi-alert-decagram-outline"
  >
    <!--
      Every row here sits in a sub-section, including the two that would happily
      stand alone. A row left at the category's top level renders identically to
      one inside a sub-section, so a lone row after a sub-section reads as the
      last item *of* it.
    -->
    <OptionSubsection
      title="Your data"
      subtitle="Move settings between installs, and share what the extension has learned."
    >
      <OptionRowImportExport />
      <OptionRowFandomExport />
    </OptionSubsection>

    <OptionSubsection
      title="Under the hood"
      subtitle="Workarounds and diagnostics. Leave these alone unless something is wrong."
    >
      <OptionRow
        title="Compress filter URLs"
        subtitle="Shortens the URL the Sort &amp; Filter sidebar produces, so a heavy set of filters stays under AO3's length limit. Your results are unchanged."
      >
        <OptionSwitch option-id="compressSearchUrls" />
      </OptionRow>
      <OptionRow
        title="Debug mode"
        subtitle="Logs what the extension is doing to the browser's developer console. Useful when reporting a problem."
      >
        <OptionSwitch option-id="verbose" />
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
