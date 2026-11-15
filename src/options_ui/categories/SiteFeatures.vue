<script setup lang="ts">
</script>

<template>
  <OptionCategory
    anchor="site-features-appearance"
    title="Site features &amp; appearance"
    subtitle="Themes/skins, site-wide features, and tweaks to AO3 behavior that don't fit anywhere else."
    icon="i-mdi-tune-variant"
    rail-label="Site features"
  >
    <!--
      "Link menus" rather than "Right-click menus": the group's own master switch
      is called that, and a sub-section whose first row repeats its heading reads
      as a mistake. It is also the more accurate of the two — with
      `openMenuOnClick` on, these are not right-click menus at all.
    -->
    <OptionSubsection
      anchor="link-menus"
      title="Link menus"
      subtitle="Right-click/long-press tags/fandoms/etc. for quick access to filtering and rule-creation features."
    >
      <OptionMasterGroup
        anchor="context-menus"
        option-id="contextMenusEnabled"
        title="Right-click menus"
        subtitle="Master switch for this group. With it off, links keep the browser's own menu. Also on the floating toolbar, and holding Shift skips the extension for one click."
      >
        <OptionRow
          anchor="open-menu-on-click"
          title="Open menus with a left-click"
          subtitle="Replaces click behavior with context menu. Shift+click follows the link; Ctrl+Shift+click opens in a new tab."
          :badges="['every-click']"
        >
          <OptionSwitch option-id="openMenuOnClick" />
        </OptionRow>
        <OptionRow
          anchor="tag-toolbar"
          title="Menu on tags"
          subtitle="Tag context menus add an option to include/exclude from the filter sidebar or add a rule."
        >
          <OptionSwitch option-id="tagToolbar" />
        </OptionRow>
        <OptionRow
          anchor="fandom-toolbar"
          title="Menu on fandoms"
          subtitle="Same as the tag menus, but for fandoms."
        >
          <OptionSwitch option-id="fandomToolbar" />
        </OptionRow>
        <OptionRow
          anchor="hide-author-toolbar"
          title="Hide or highlight an author"
          subtitle="Adds hide, collapse, always-show and highlight to an author menu."
        >
          <OptionSwitch option-id="hideAuthorToolbar" />
        </OptionRow>
        <OptionRow
          anchor="subscribe-author-toolbar"
          title="Subscribe to an author"
          subtitle="Adds subscribe / unsubscribe to an author's menu. Your current subscription is looked up when the menu opens."
          :badges="['needs-login']"
        >
          <OptionSwitch option-id="subscribeAuthorToolbar" />
        </OptionRow>
        <OptionRow
          anchor="mute-author-toolbar"
          title="Mute an author"
          subtitle="Adds mute / unmute to an author's menu (hides author's works, series, bookmarks and comments across AO3)."
          :badges="['needs-login']"
        >
          <OptionSwitch option-id="muteAuthorToolbar" />
        </OptionRow>
      </OptionMasterGroup>
      <!--
        Not gated by Right-click menus: with menus off it still drives the mark
        buttons on a work and the entity toolbars.
      -->
      <OptionRow
        anchor="mark-for-later-toolbar"
        title="Mark a work for later"
        subtitle="Adds “Mark for later” and “Mark as read” to a work's menu, so you can update your Marked for Later list without opening the work. Your Marked for Later list's own search view has them either way."
        :badges="['needs-login']"
      >
        <OptionSwitch option-id="markForLaterToolbar" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      anchor="page-controls"
      title="Page controls"
      subtitle="Controls the extension adds to the page itself, for things you want one tap away."
    >
      <OptionRow
        anchor="filter-toolbar"
        title="Reveal filtered works"
        subtitle="Adds “Show filtered works” toggle to the floating toolbar."
      >
        <OptionSwitch option-id="filterToolbar" />
      </OptionRow>
      <OptionRow
        anchor="collapsible-dashboard"
        title="Collapsible dashboard sidebar"
        subtitle="On your own user pages, click the red band at the top of the sidebar to fold it away and give the page its full width; a thin red rail on the left edge brings it back."
        :badges="['this-device']"
      >
        <OptionSwitch option-id="collapsibleDashboard" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      anchor="appearance"
      title="Appearance"
      subtitle="Themes, skins, and misc. features."
    >
      <OptionRow
        anchor="theme"
        title="Extension theme"
        subtitle="Light or dark for the extension's own pages, menus and popups. AO3's own colours come from the site skin you chose there, or from the dark skin below."
      >
        <OptionTheme />
      </OptionRow>
      <OptionRow
        anchor="dark-skin"
        title="Dark skin for AO3"
        subtitle="Restyles AO3 itself to look like this page in its dark theme: the same colours, rounded fields and outlined buttons. If you already use a site skin chosen on AO3, this one goes on top of it."
      >
        <OptionSwitch option-id="darkSkin" />
      </OptionRow>
      <OptionRow
        anchor="show-stats-columns"
        title="Show statistics in columns"
        subtitle="Lays each statistic out as a small label above its value instead of a run-on line, so a work's statistics still fit on one row. Applies to work and chapter statistics alike."
      >
        <OptionSwitch option-id="showStatsColumns" />
      </OptionRow>
      <OptionRow
        anchor="hide-muted-author-notices"
        title="Hide “muted author” notices"
        subtitle="Removes AO3's notes warning that some works may be hidden because you have muted their author."
      >
        <OptionSwitch option-id="hideMutedAuthorNotices" />
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
