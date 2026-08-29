<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Style tweaks"
    subtitle="Make reading easier!"
    icon="mdi-format-paint"
  >
    <template #icon>
      <Icon i-mdi-palette />
    </template>
    <OptionRowNumberSlider
      title="Decrease width of work text"
      subtitle="Makes reading on wide screens easier; 0 to disable"
      option-enabled-id="styleWidthEnabled"
      option-id="styleWidth"
      unit="%"
      :min="0"
      :max="100"
    />
    <OptionDivider />
    <OptionRow
      title="Reader mode on works"
      subtitle="Zoom (Ctrl+scroll or pinch) over the work text resizes its font; drag the handles on its edges to set the reading width. Saved on this device only."
    >
      <OptionSwitch option-id="readerMode" />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Collapsible dashboard sidebar"
      subtitle="On your own user pages, click the red band at the top of the sidebar to fold it away; a thin red rail on the left edge brings it back. Remembered on this device only."
    >
      <OptionSwitch option-id="collapsibleDashboard" />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Force alignment of work text"
      subtitle="Can sometimes help with readability"
    >
      <OptionForceAlignment />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Show stats as columns"
      subtitle="Applies to both work and chapter stats"
    >
      <OptionSwitch option-id="showStatsColumns" />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Hide muted author notices"
      subtitle="Removes the notes warning that works may be hidden because of a muted author"
    >
      <OptionSwitch option-id="hideMutedAuthorNotices" />
    </OptionRow>
    <OptionDivider />
    <OptionRowTextReplacements />
  </OptionCategory>
</template>
