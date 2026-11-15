<script setup lang="ts">
</script>

<template>
  <OptionCategory
    anchor="reading"
    title="Reading"
    subtitle="Keeping track of what you've read, how long a work will take, and how its text is laid out."
    icon="i-mdi-book-open-page-variant"
  >
    <OptionSubsection
      anchor="marks-status"
      title="Marks &amp; status"
      subtitle="Remember what you've read and what you thought of it. Marks live in your settings rather than on AO3, and can hide marked works from listings."
    >
      <OptionRowWorkMarks />
    </OptionSubsection>

    <OptionSubsection
      anchor="work-statistics"
      title="Work statistics"
      subtitle="Extra numbers on a work's stats line, wherever it appears — a listing, a series page, or the top of the work itself."
    >
      <OptionRowNumberSlider
        anchor="words-per-minute"
        title="Reading speed"
        subtitle="Words per minute. Every reading-time and finish-time estimate below is calculated from it."
        option-id="wordsPerMinute"
        unit="&nbsp;WPM"
        :min="0"
        :slider-min="50"
        :slider-max="1000"
      />
      <OptionRow
        anchor="show-total-time"
        title="Reading time"
        subtitle="How long the whole work will take you at your reading speed."
      >
        <OptionSwitch option-id="showTotalTime" />
      </OptionRow>
      <OptionRow
        anchor="show-total-finish"
        title="Finish reading at"
        subtitle="The clock time you would finish the whole work if you started now."
      >
        <OptionSwitch option-id="showTotalFinish" />
      </OptionRow>
      <OptionRow
        anchor="show-kudos-hits-ratio"
        title="Kudos/hits ratio"
        subtitle="What share of readers left kudos — a rough popularity signal AO3 doesn't show."
      >
        <OptionSwitch option-id="showKudosHitsRatio" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      anchor="chapter-statistics"
      title="Chapter statistics"
      subtitle="A stats block on each chapter as you read. Shown only if at least one of these is on."
    >
      <OptionRow
        anchor="show-chapter-words"
        title="Word count"
        subtitle="How long this chapter is on its own."
      >
        <OptionSwitch option-id="showChapterWords" />
      </OptionRow>
      <OptionRow
        anchor="show-chapter-time"
        title="Reading time"
        subtitle="How long this chapter will take you at your reading speed."
      >
        <OptionSwitch option-id="showChapterTime" />
      </OptionRow>
      <OptionRow
        anchor="show-chapter-finish"
        title="Finish reading at"
        subtitle="The clock time you would finish this chapter if you started now."
      >
        <OptionSwitch option-id="showChapterFinish" />
      </OptionRow>
      <OptionRow
        anchor="show-chapter-date"
        title="Last updated"
        subtitle="The date this chapter was posted."
      >
        <OptionSwitch option-id="showChapterDate" />
      </OptionRow>
    </OptionSubsection>

    <OptionSubsection
      anchor="work-text"
      title="Work text"
      subtitle="How a work's own text is sized, laid out and worded while you read it."
    >
      <OptionRow
        anchor="reader-mode"
        title="Reader mode"
        subtitle="Zoom over the work text (Ctrl+scroll, or pinch on a trackpad) to resize and reflow it instead of zooming the page, and drag the handles at its left and right edges to set the reading width."
        :badges="['this-device']"
      >
        <OptionSwitch option-id="readerMode" />
      </OptionRow>
      <OptionRowNumberSlider
        anchor="style-width"
        title="Narrow the work text"
        subtitle="Shrinks the reading column, which makes long lines easier to follow on a wide screen. 0 leaves the width alone."
        option-enabled-id="styleWidthEnabled"
        option-id="styleWidth"
        unit="%"
        :min="0"
        :max="100"
      />
      <OptionRow
        anchor="force-alignment"
        title="Force text alignment"
        subtitle="Override the alignment an author set — for a work centred or justified in a way you find hard to read."
      >
        <OptionForceAlignment />
      </OptionRow>
      <OptionRowTextReplacements />
    </OptionSubsection>
  </OptionCategory>
</template>
