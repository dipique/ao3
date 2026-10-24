<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Site features &amp; appearance"
    subtitle="What the extension adds to every AO3 page, and how it looks."
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
      title="Link menus"
      subtitle="Right-click — or long-press — a tag, fandom, author or work to act on it without leaving the page."
    >
      <OptionMasterGroup
        option-id="contextMenusEnabled"
        title="Right-click menus"
        subtitle="Master switch for this group. With it off, links keep the browser's own menu. Also on the floating toolbar, and holding Shift skips the extension for one click."
      >
        <OptionRow
          title="Open menus with a left-click"
          subtitle="A plain click or tap on a tag, fandom or author opens its menu instead of following the link; the menu's “Open” item still follows it. Shift+click follows the link, so Ctrl+Shift+click still opens it in a new tab."
          :badges="['every-click']"
        >
          <OptionSwitch option-id="openMenuOnClick" />
        </OptionRow>
        <OptionRow
          title="Menu on tags"
          subtitle="Include or exclude a tag in the Sort &amp; Filter sidebar, or hide, always-show or highlight it everywhere. Tags that already have a rule get a small indicator."
        >
          <OptionSwitch option-id="tagToolbar" />
        </OptionRow>
        <OptionRow
          title="Menu on fandoms"
          subtitle="The same actions on fandoms. Fandoms are filtered by id from a bundled list, so any fandom works — not just the ten the sidebar offers."
        >
          <OptionSwitch option-id="fandomToolbar" />
        </OptionRow>
        <OptionRow
          title="Hide or highlight an author"
          subtitle="Adds hide, collapse, always-show and highlight to an author's menu, so you can manage author rules from any byline. An indicator shows next to the name when one is active."
        >
          <OptionSwitch option-id="hideAuthorToolbar" />
        </OptionRow>
        <OptionRow
          title="Subscribe to an author"
          subtitle="Adds subscribe / unsubscribe to an author's menu. Your current subscription is looked up when the menu opens."
          :badges="['needs-login']"
        >
          <OptionSwitch option-id="subscribeAuthorToolbar" />
        </OptionRow>
        <OptionRow
          title="Mute an author"
          subtitle="Adds mute / unmute to an author's menu. Muting hides that author's works, series, bookmarks and comments from you across AO3."
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
        title="Mark a work for later"
        subtitle="Adds “Mark for later” and “Mark as read” to a work's menu, so you can update your Marked for Later list without opening the work. Your Marked for Later list's own search view has them either way."
        :badges="['needs-login']"
      >
        <OptionSwitch option-id="markForLaterToolbar" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      title="Page controls"
      subtitle="Controls the extension adds to the page itself, for things you want one tap away."
    >
      <OptionRow
        title="Reveal filtered works"
        subtitle="Adds “Show N filtered works” to the floating toolbar in the bottom-right corner, which reveals what your filters hid without changing them. It appears only where something is hidden; the toolbar itself is always there for its other quick actions."
      >
        <OptionSwitch option-id="filterToolbar" />
      </OptionRow>
      <OptionRow
        title="Collapsible dashboard sidebar"
        subtitle="On your own user pages, click the red band at the top of the sidebar to fold it away and give the page its full width; a thin red rail on the left edge brings it back."
        :badges="['this-device']"
      >
        <OptionSwitch option-id="collapsibleDashboard" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      title="Appearance"
      subtitle="How the extension's own pages, menus and additions to AO3 look, and AO3 itself if you want it dark."
    >
      <OptionRow
        title="Extension theme"
        subtitle="Light or dark for the extension's own pages, menus and popups. AO3's own colours come from the site skin you chose there, or from the dark skin below."
      >
        <OptionTheme />
      </OptionRow>
      <OptionRow
        title="Dark skin for AO3"
        subtitle="Restyles AO3 itself to look like this page in its dark theme: the same colours, rounded fields and outlined buttons. If you already use a site skin chosen on AO3, this one goes on top of it."
      >
        <OptionSwitch option-id="darkSkin" />
      </OptionRow>
      <OptionRow
        title="Show statistics in columns"
        subtitle="Lays each statistic out as a small label above its value instead of a run-on line, so a work's statistics still fit on one row. Applies to work and chapter statistics alike."
      >
        <OptionSwitch option-id="showStatsColumns" />
      </OptionRow>
      <OptionRow
        title="Hide “muted author” notices"
        subtitle="Removes AO3's notes warning that some works may be hidden because you have muted their author."
      >
        <OptionSwitch option-id="hideMutedAuthorNotices" />
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
