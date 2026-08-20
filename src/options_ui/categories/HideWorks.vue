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
      subtitle="On a collapsed work, show the actual tag/fandom/author that matched (instead of the rule that hid it); hover a value (or tap/long-press it on touch) to see the matching rule. Each value gets an exclude (−) button that adds it straight to the filter sidebar."
    >
      <OptionSwitch option-id="hideShowMatchedValues" />
    </OptionRow>
    <OptionDivider />
    <OptionRowHideCrossovers />
    <OptionDivider />
    <OptionRowHideLanguages />
    <OptionDivider />
    <OptionRow
      title="Hide author in the author menu"
      subtitle="Add hide / always-show / highlight actions to an author's right-click (or long-press) menu, so you can manage your author rules from any byline. A hidden/highlight indicator shows next to the name when active."
    >
      <OptionSwitch option-id="hideAuthorToolbar" />
    </OptionRow>
    <OptionRow
      title="Subscribe to author in the author menu"
      subtitle="Add a subscribe / unsubscribe action to the author's right-click (or long-press) menu. Your current subscription status is loaded when the menu opens. Requires being logged in to AO3."
    >
      <OptionSwitch option-id="subscribeAuthorToolbar" />
    </OptionRow>
    <OptionRow
      title="Mute author in the author menu"
      subtitle="Add a mute / unmute action to the author's right-click (or long-press) menu — muting completely hides all of their works, series, bookmarks, and comments from you. Your current mute status is loaded when the menu opens. Requires being logged in to AO3."
    >
      <OptionSwitch option-id="muteAuthorToolbar" />
    </OptionRow>
    <OptionDivider />
    <OptionRowRules />
    <OptionDivider />
    <OptionRowWorkMarks />
    <OptionDivider />
  </OptionCategory>
</template>
