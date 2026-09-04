<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Site features &amp; appearance"
    subtitle="What the extension adds to AO3 everywhere, and how it looks."
  >
    <template #icon>
      <Icon i-mdi-tune-variant />
    </template>

    <OptionSubsection
      title="Right-click menus"
      subtitle="Right-click — or long-press on a touchscreen — a tag, fandom, author or work to act on it without leaving the page. Turn on the ones you want."
    >
      <OptionRow
        title="Right-click menus"
        subtitle="The master switch for everything in this group. With it off, links keep the browser's own right-click menu. You can also flip it from the floating toolbar's “Disable menus” button on any page, or hold Shift to skip the extension for a single click."
      >
        <OptionSwitch option-id="contextMenusEnabled" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Open menus with a left-click"
        subtitle="Makes a plain click or tap on a tag, fandom or author open its menu instead of following the link. The menu's “Open” item still follows it, so nothing is lost. Holding Shift stands the extension down for one gesture — Shift+click follows the link, so Ctrl+Shift+click still opens it in a new tab."
      >
        <OptionSwitch option-id="openMenuOnClick" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Menu on tags"
        subtitle="Include or exclude a tag in the Sort &amp; Filter sidebar, or hide, always-show or highlight it everywhere. A small indicator marks tags that already have a rule."
      >
        <OptionSwitch option-id="tagToolbar" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Menu on fandoms"
        subtitle="The same include/exclude and hide/always-show/highlight actions on fandoms. Fandoms are filtered by id from a bundled list, so any fandom works — not just the ten the sidebar offers."
      >
        <OptionSwitch option-id="fandomToolbar" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Hide or highlight an author"
        subtitle="Adds hide, collapse, always-show and highlight actions to an author's menu, so you can manage your author rules from any byline. An indicator shows next to the name when one is active."
      >
        <OptionSwitch option-id="hideAuthorToolbar" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Subscribe to an author"
        subtitle="Adds subscribe / unsubscribe to an author's menu. Your current subscription is looked up when the menu opens. Requires being logged in to AO3."
      >
        <OptionSwitch option-id="subscribeAuthorToolbar" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Mute an author"
        subtitle="Adds mute / unmute to an author's menu. Muting hides all of that author's works, series, bookmarks and comments from you across AO3. Requires being logged in to AO3."
      >
        <OptionSwitch option-id="muteAuthorToolbar" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Mark a work for later"
        subtitle="Adds “Mark for later” and “Mark as read” to a work's menu, so you can update your Marked for Later list without opening the work."
      >
        <OptionSwitch option-id="markForLaterToolbar" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      title="Page controls"
      subtitle="Buttons the extension adds to the page itself, for things you want one tap away."
    >
      <OptionRow
        title="Floating toolbar"
        subtitle="A small button in the bottom-right corner of AO3 pages. It can reveal works your filters hid (without changing the filters), switch the right-click menus off, and toggle reader mode on a work page. It appears only when one of those applies to the page you are on."
      >
        <OptionSwitch option-id="filterToolbar" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Collapsible dashboard sidebar"
        subtitle="On your own user pages, click the red band at the top of the sidebar to fold it away and give the page its full width; a thin red rail on the left edge brings it back. Remembered on this device only."
      >
        <OptionSwitch option-id="collapsibleDashboard" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      title="Appearance"
      subtitle="How the extension's own pages, menus and additions to AO3 look."
    >
      <OptionRow
        title="Extension theme"
        subtitle="Light or dark for the extension's own pages, menus and popups. AO3's own colours come from the site skin you have chosen there."
      >
        <OptionTheme />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Show statistics in columns"
        subtitle="Lays each statistic out as a label above its value instead of a run-on line. Applies to both the work stats and the chapter stats below."
      >
        <OptionSwitch option-id="showStatsColumns" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Hide “muted author” notices"
        subtitle="Removes AO3's notes warning that some works may be hidden because you have muted their author."
      >
        <OptionSwitch option-id="hideMutedAuthorNotices" />
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
