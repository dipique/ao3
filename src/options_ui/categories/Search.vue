<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Search"
    subtitle="Finding works: better search pages, filter defaults, and what to keep out of your results."
  >
    <template #icon>
      <Icon i-mdi-magnify />
    </template>

    <OptionSubsection
      title="Instant search views"
      subtitle="Load a whole listing into one page you can filter and sort instantly — by tag, fandom, rating, length, kudos and more — instead of clicking through twenty works at a time."
    >
      <OptionRow
        title="Search your Marked for Later list"
        subtitle="Adds a button to your own Marked for Later page that loads every page of your to-read list into the instant search view."
      >
        <OptionSwitch option-id="searchMarkedForLater" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Search an uncommon tag's works"
        subtitle="AO3 only lets you sort and filter a tag's works once the tag has been made canonical; for every other tag you get a plain paged list and nothing else. Adds a “Search these works” link to those pages."
      >
        <OptionSwitch option-id="searchTagWorks" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Search text-search results"
        subtitle="Adds a “Search these results” button to the results of a works search, so you can narrow them by things AO3's own results page gives you no way to filter on."
      >
        <OptionSwitch option-id="searchTextResults" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Maximum works to load"
        subtitle="A ceiling on how many works any of the views above will load. Each is fetched twenty to a page from AO3's donated servers, and a text search for a common word can match hundreds of thousands — so a bigger list loads only up to this ceiling, in the order the Archive lists it, and only after you confirm. Raise it if you routinely search large lists and don't mind the wait."
      >
        <OptionSearchMaxResults />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Results per page"
        subtitle="How many works to show at a time in the views above. Lower values stay fast even on very large lists; higher values show more at once but take longer to render."
      >
        <OptionSearchPerPage />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      title="Filter defaults"
      subtitle="Values AO3's own Sort &amp; Filter sidebar and search forms should start with. Only applied when you haven't already chosen one, so anything in the URL wins."
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
      <OptionRowHideCrossovers />
      <OptionDivider />
      <OptionRowHideLanguages />
      <OptionDivider />
      <OptionRow
        title="Collapse or hide"
        subtitle="What to do with a work hidden by the two filters above, or by a mark set to hide it. Collapsing leaves a line saying why, with a button to show the work anyway. Rules choose this for themselves, per rule."
      >
        <OptionHideReason />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Show what matched"
        subtitle="On a collapsed work, show the actual tag, fandom or author that matched instead of the name of the rule that hid it. Hover a value — or tap it on a touchscreen — to see the rule, and use its exclude (−) button to add it straight to the filter sidebar."
      >
        <OptionSwitch option-id="hideShowMatchedValues" />
      </OptionRow>
    </OptionSubsection>
  </OptionCategory>
</template>
