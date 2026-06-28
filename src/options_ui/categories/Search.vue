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
      title="Tag context menu"
      subtitle="Right-click (or long-press on touch) a tag on a works listing for a menu to include/exclude it in the filter, or hide / always-show / highlight it. A small indicator appears next to a tag only when one of these is active. Include/exclude uses the existing sidebar checkbox when there is one."
    >
      <OptionSwitch option-id="tagToolbar" />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Fandom context menu"
      subtitle="Right-click (or long-press) a fandom on a works listing for the same include/exclude and hide/always-show/highlight menu. Fandoms are filtered by id, looked up from a bundled list (with an on-demand fallback), so any fandom can be filtered — not just the sidebar's top ten."
    >
      <OptionSwitch option-id="fandomToolbar" />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Mark for later in the work menu"
      subtitle="Add a “Mark for later” / “Mark as read” action to a work's right-click (or long-press) menu, so you can update your Marked for Later list without opening the work. A saved indicator shows next to works you marked this session."
    >
      <OptionSwitch option-id="markForLaterToolbar" />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Filter peek toolbar"
      subtitle="On listing pages where your filters hid works, show a small floating button to temporarily reveal those works (and hide them again). Works for tag, author, crossover and language filters. Does not change your saved filters. The floating toolbar also hosts a toggle to disable the extension's right-click menus (restoring the browser's native menu) whenever any menu feature is on."
    >
      <OptionSwitch option-id="filterToolbar" />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Search Marked for Later"
      subtitle="On your own Marked for Later page, add a button that loads every page of your to-read list into one view you can instantly filter and sort by tags, fandoms, rating, length, kudos and more."
    >
      <OptionSwitch option-id="searchMarkedForLater" />
    </OptionRow>
    <OptionDivider />
    <OptionRowFandomExport />
  </OptionCategory>
</template>
