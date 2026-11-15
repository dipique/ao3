<script setup lang="ts">
</script>

<template>
  <OptionCategory
    anchor="advanced"
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
      anchor="your-data"
      title="Your data"
      subtitle="Move settings between installs, and share what the extension has learned."
    >
      <OptionRowImportExport />
      <OptionRowFandomExport />
    </OptionSubsection>

    <OptionSubsection
      anchor="under-the-hood"
      title="Under the hood"
      subtitle="Workarounds and diagnostics. Leave these alone unless something is wrong."
    >
      <OptionRow
        anchor="compress-search-urls"
        title="Compress filter URLs"
        subtitle="Shortens the URL the Sort &amp; Filter sidebar produces, so a heavy set of filters stays under AO3's length limit. Your results are unchanged."
      >
        <OptionSwitch option-id="compressSearchUrls" />
      </OptionRow>
      <OptionRow
        anchor="verbose"
        title="Debug mode"
        subtitle="Logs what the extension is doing to the browser's developer console. Useful when reporting a problem."
      >
        <OptionSwitch option-id="verbose" />
      </OptionRow>
      <OptionRow
        anchor="impersonate-user-requests"
        title="Impersonate user requests"
        subtitle="This option bypasses AO3's intentional traffic control mechanisms. Using it may cause problems for AO3, and may get your account temporarily or permanently banned. Use with extreme caution."
        :badges="['this-device']"
      >
        <OptionSwitch option-id="impersonateUserRequests" />
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
