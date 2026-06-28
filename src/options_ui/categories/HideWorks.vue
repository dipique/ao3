<script setup lang="ts">
import { DEFAULT_SERIES_HIGHLIGHT_COLOR, DEFAULT_WORK_HIGHLIGHT_COLOR } from '#common'
</script>

<template>
  <OptionCategory
    title="Hide (or highlight!) works"
    subtitle="Hide or emphasize works based on criteria."
  >
    <template #icon>
      <Icon i-mdi-eye-off />
    </template>
    <OptionRow
      title="Collapse/hide matching works"
      subtitle="For when you want to hide works but still see why they were hidden and have the option to show them."
    >
      <OptionHideReason />
    </OptionRow>
    <OptionDivider />
    <OptionRow
      title="Show matched values"
      subtitle="On a collapsed work, show the actual tag/fandom/author that matched (instead of the rule that hid it) and hover any value to see the matching rule. Each value gets an exclude (−) button that adds it straight to the filter sidebar."
    >
      <OptionSwitch option-id="hideShowMatchedValues" />
    </OptionRow>
    <OptionDivider />
    <OptionRowHideCrossovers />
    <OptionDivider />
    <OptionRowHideLanguages />
    <OptionDivider />
    <OptionRow
      title="Hide author button"
      subtitle="Show a button after each author's name (on works listings, work pages, etc.) to add or remove them from your hidden authors list with one click."
    >
      <OptionSwitch option-id="hideAuthorToolbar" />
    </OptionRow>
    <OptionRow
      title="Subscribe to author button"
      subtitle="Show a button after each author's name (next to the hide-author button) to subscribe to or unsubscribe from that author with one click. Hover the button to load your current subscription status. Requires being logged in to AO3."
    >
      <OptionSwitch option-id="subscribeAuthorToolbar" />
    </OptionRow>
    <OptionRow
      title="Mute author button"
      subtitle="Show a button after each author's name (next to the subscribe button) to mute or unmute that author with one click — muting completely hides all of their works, series, bookmarks, and comments from you. Hover the button to load your current mute status. Requires being logged in to AO3."
    >
      <OptionSwitch option-id="muteAuthorToolbar" />
    </OptionRow>
    <OptionRowHideAuthors />
    <OptionDivider />
    <OptionRowHideTags />
    <OptionDivider />
    <OptionRowHideEntities
      option-key="hideWorks"
      title="Works"
      subtitle="Hide, highlight, or always-show specific works by title or id"
      noun="work"
      :default-color="DEFAULT_WORK_HIGHLIGHT_COLOR"
    />
    <OptionDivider />
    <OptionRowHideEntities
      option-key="hideSeries"
      title="Series"
      subtitle="Hide, highlight, or always-show specific series by title or id"
      noun="series"
      :default-color="DEFAULT_SERIES_HIGHLIGHT_COLOR"
    />
    <OptionDivider />
  </OptionCategory>
</template>
