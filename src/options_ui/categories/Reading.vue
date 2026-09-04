<script setup lang="ts">
</script>

<template>
  <OptionCategory
    title="Reading"
    subtitle="Keeping track of what you've read, how long a work will take, and how its text is laid out."
  >
    <template #icon>
      <Icon i-mdi-book-open-page-variant />
    </template>

    <OptionSubsection
      title="Marks &amp; status"
      subtitle="Remember what you have read and what you thought of it. Marks are the extension's own — they live in your settings, not on AO3 — and can hide marked works from listings."
    >
      <OptionRowWorkMarks />
    </OptionSubsection>

    <OptionSubsection
      title="Work statistics"
      subtitle="Extra numbers on a whole work's stats line — wherever it appears: in a listing, on a series page, or at the top of the work itself."
    >
      <OptionRowNumberSlider
        title="Reading speed"
        subtitle="In words per minute. Every reading-time and finish-time estimate on this page is calculated from it."
        option-id="wordsPerMinute"
        unit="&nbsp;WPM"
        :min="0"
        :slider-min="50"
        :slider-max="1000"
      />
      <OptionDivider />
      <OptionRow
        title="Reading time"
        subtitle="How long the whole work will take you at your reading speed."
      >
        <OptionSwitch option-id="showTotalTime" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Finish reading at"
        subtitle="The clock time you would finish the whole work if you started now."
      >
        <OptionSwitch option-id="showTotalFinish" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Kudos/hits ratio"
        subtitle="What share of readers left kudos — a rough popularity signal AO3 doesn't show."
      >
        <OptionSwitch option-id="showKudosHitsRatio" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      title="Chapter statistics"
      subtitle="A stats block on each chapter as you read a work. Shown only if at least one of these is on."
    >
      <OptionRow
        title="Word count"
        subtitle="How long this chapter is on its own."
      >
        <OptionSwitch option-id="showChapterWords" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Reading time"
        subtitle="How long this chapter will take you at your reading speed."
      >
        <OptionSwitch option-id="showChapterTime" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Finish reading at"
        subtitle="The clock time you would finish this chapter if you started now."
      >
        <OptionSwitch option-id="showChapterFinish" />
      </OptionRow>
      <OptionDivider />
      <OptionRow
        title="Last updated"
        subtitle="The date this chapter was posted."
      >
        <OptionSwitch option-id="showChapterDate" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      title="Work text"
      subtitle="How a work's own text is sized, laid out and worded while you read it."
    >
      <OptionRow
        title="Reader mode"
        subtitle="Zoom (Ctrl+scroll, or pinch on a trackpad) over the work text to resize its font and reflow it instead of zooming the page, and drag the handles on its left and right edges to set the reading width. Saved on this device only."
      >
        <OptionSwitch option-id="readerMode" />
      </OptionRow>
      <OptionDivider />
      <OptionRowNumberSlider
        title="Narrow the work text"
        subtitle="Shrinks the reading column by this much, which makes long lines easier to follow on a wide screen. 0 to leave the width alone."
        option-enabled-id="styleWidthEnabled"
        option-id="styleWidth"
        unit="%"
        :min="0"
        :max="100"
      />
      <OptionDivider />
      <OptionRow
        title="Force text alignment"
        subtitle="Override the alignment an author set on their work — useful when a work is centred or justified in a way you find hard to read."
      >
        <OptionForceAlignment />
      </OptionRow>
      <OptionDivider />
      <OptionRowTextReplacements />
    </OptionSubsection>
  </OptionCategory>
</template>
