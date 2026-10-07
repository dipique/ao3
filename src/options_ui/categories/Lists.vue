<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Lists"
    subtitle="The searches, tags and series you keep — reviewed for what’s new, and saved to read offline. Lists arrive from AO3 itself; this is where you look after them."
    icon="i-mdi-format-list-bulleted"
    jobs
  >
    <OptionSubsection
      title="Review"
      subtitle="What’s new across the lists you track, a range of days at a time."
    >
      <OptionRowTrackedLists />
    </OptionSubsection>

    <OptionSubsection
      title="Saved lists"
      :strong="['Saved', 'Offline copy', 'Tracked']"
      subtitle="One row per search, tag or series you keep. Every row is Saved: its works can be cached, and downloaded as an Offline copy to read anywhere. A Tracked list does all that too, and its new and updated works are gathered into your review. The title is yours to set — it is what the review’s “List source” filter calls the list."
    >
      <SavedLists />
    </OptionSubsection>

    <OptionSubsection
      title="User profile lists"
      subtitle="Your own profile pages: the two biggest lists you have, fetched only while you are signed in, and never tracked — what’s on them is your own doing, so “what’s new?” isn’t a question about them."
    >
      <ProfileLists />
    </OptionSubsection>

    <OptionSubsection
      title="Offline reading"
      subtitle="Save a works list and the text of its works as one self-contained HTML file — readable anywhere, including a device with no extensions. Work text is held per work, not per list, so lists that share a work share one copy."
    >
      <SiteExportChanges />
      <SiteExportCache />
      <OptionRow
        title="Discard unneeded blurbs automatically"
        subtitle="When a refresh drops a work from a stored list, or a list is deleted, forget that work's blurb straight away if no other list holds it — instead of waiting for Discard orphans. Cached work text is never touched."
      >
        <OptionSwitch option-id="pruneOrphanedBlurbs" />
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
