<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Search"
    subtitle="Better search pages, filter defaults, and what to keep out of your results."
  >
    <template #icon>
      <Icon i-mdi-magnify />
    </template>

    <OptionSubsection
      title="Instant search views"
      subtitle="Load a whole listing into one page you can sort and filter instantly — by tag, fandom, rating, length, kudos and more — instead of paging through twenty works at a time."
    >
      <OptionRow
        title="Search your Marked for Later list"
        subtitle="Adds a button to your own Marked for Later page that loads the whole to-read list into the instant search view."
      >
        <OptionSwitch option-id="searchMarkedForLater" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Search an uncommon tag's works"
        subtitle="AO3 only sorts and filters a tag's works once the tag has been made canonical; every other tag gets a plain paged list. Adds a “Search these works” link to those pages."
      >
        <OptionSwitch option-id="searchTagWorks" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Search a series' works"
        subtitle="AO3 gives a series page no way to sort or filter it, however long the series runs. Adds a “Search these works” button next to Bookmark Series."
      >
        <OptionSwitch option-id="searchSeriesWorks" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Search text-search results"
        subtitle="Adds a “Search these results” button to the results of a works search, so you can narrow them by things AO3's own results page can't filter on."
      >
        <OptionSwitch option-id="searchTextResults" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Maximum works to load"
        subtitle="A ceiling on how many works the views above will load. Works come twenty to a page from AO3's donated servers, and a text search for a common word can match hundreds of thousands — so a bigger list loads only up to this ceiling, in the Archive's own order, and only after you confirm."
      >
        <OptionSearchMaxResults />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Results per page"
        subtitle="How many works to show at a time in the views above. Lower values stay fast even on very large lists."
      >
        <OptionSearchPerPage />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      title="Filter defaults"
      subtitle="Values AO3's own Sort &amp; Filter sidebar and search forms should start with. Applied only when you haven't already chosen one, so anything in the URL wins."
    >
      <OptionRowSearchLanguage />
      <OptionDivider />
      <OptionRowSearchWordCount />
      <OptionDivider />
      <OptionRowWordCountRanges />
    </OptionSubsection>

    <OptionSubsection
      title="Hiding &amp; highlighting works"
      subtitle="Keep works you don't want out of your listings, and make the ones you do want stand out. Applies anywhere works are listed — search results, a tag's works, bookmarks, your dashboard."
    >
      <OptionRowRules />
      <OptionDivider />
      <OptionRow
        title="Exclude hidden works from the search"
        subtitle="When a rule hides a work outright, add what hid it to the search itself — ticking AO3's own Sort &amp; Filter exclusions, and typing in tags it doesn't list when the rule names one exactly. Stops a page of twenty arriving with one work left on it. Nothing is submitted for you: press Sort and Filter when you're ready. Values still carried by a work you've told the extension to always show are left alone."
      >
        <OptionSwitch option-id="autoExcludeHidden" />
      </OptionRow>
      <OptionDivider />
      <OptionRowHideCrossovers />
      <OptionDivider />
      <OptionRowHideLanguages />
      <OptionDivider />
      <OptionRow
        title="Collapse or hide"
        subtitle="What to do with a work hidden by the crossover or language filter, or by a mark set to hide it. Collapsing leaves a line saying why, with a button to show the work anyway. Rules choose this for themselves, per rule."
      >
        <OptionHideReason />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Show what matched"
        subtitle="On a collapsed work, name the tag, fandom or author that matched rather than the rule that hid it. Hover a value — or tap it on a touchscreen — to see its rule, and use its exclude (−) button to add it straight to the filter sidebar."
      >
        <OptionSwitch option-id="hideShowMatchedValues" />
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
