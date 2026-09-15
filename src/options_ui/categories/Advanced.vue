<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Advanced"
    subtitle="Your data, offline exports, and settings most people never need to touch."
  >
    <template #icon>
      <Icon i-mdi-alert-decagram-outline />
    </template>

    <!--
      Every row here sits in a sub-section, including the two that would happily
      stand alone. A row left at the category's top level renders identically to
      one inside a sub-section, so a lone row after a sub-section reads as the
      last item *of* it — which is how "Debug mode" spent its life looking like
      part of Site export.
    -->
    <OptionSubsection
      title="Your data"
      subtitle="Move settings between installs, and share what the extension has learned."
    >
      <OptionRowImportExport />
      <OptionDivider />
      <OptionRowFandomExport />
    </OptionSubsection>

    <OptionSubsection
      title="Site export"
      subtitle="Save a works list and the text of its works as one self-contained HTML file — readable anywhere, including a device with no extensions."
    >
      <SiteExportLists />
      <OptionDivider />
      <SiteExportChanges />
      <OptionDivider />
      <SiteExportCache />
      <OptionDivider />
      <OptionRow
        title="Discard unneeded blurbs automatically"
        subtitle="When a refresh drops a work from a stored list, or a list is deleted, forget that work's blurb straight away if no other list holds it — instead of waiting for Discard orphans. Cached work text is never touched."
      >
        <OptionSwitch option-id="pruneOrphanedBlurbs" />
      </OptionRow>
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
      <OptionDivider />
      <OptionRow
        title="Debug mode"
        subtitle="Logs what the extension is doing to the browser's developer console. Useful when reporting a problem."
      >
        <OptionSwitch option-id="verbose" />
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
