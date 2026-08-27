<script setup lang="ts">
const { enabled } = useOption('rules')

OptionRowRulesContext.provide({
  editDialog: ref(null),
})
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Rules"
    subtitle="Hide, highlight, or always-show works by tag, fandom, author, work, or series"
  >
    <OptionRowRulesTable />

    <div flex="~ items-center gap-3 justify-between" mt-3>
      <OptionRowRuleColors />
      <Dialog>
        <DialogTrigger as-child>
          <Button variant="link">
            Open notes/help on rules.
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>
            Rules notes
          </DialogTitle>
          <DialogDescription class="sr-only">
            Notes on how rules work and their current limitations.
          </DialogDescription>
          <div flex="~ col" class="[&_h2]:text-lg [&_p]:text-sm [&_h2]:font-medium">
            <h2 py-1>
              How to use
            </h2>
            <p>
              Each rule says what it applies to — a tag (of any type, or one specific type), an author, a work, or a
              series — what to match, and what to do with the works it matches.
              Works matched by <Icon i-tabler-eye-off op40 label="Hide" title="Hide" /> leave the listing entirely;
              works matched by <Icon i-mdi-arrow-collapse-vertical op60 label="Collapse" title="Collapse" /> stay
              where they are, squeezed down to a line saying why with a button to show them.
              Works matched by <Icon i-tabler-eye-exclamation op100 label="Show" title="Show" /> are shown even when
              something else would hide them.
              Matches marked <Icon i-mdi-star op100 label="Highlight" title="Highlight" /> are instead highlighted in a
              colour of your choice, without changing what is hidden.
              Force-shown (<Icon i-tabler-eye-exclamation op100 label="Show" title="Show" />) matches are highlighted
              too by default so they stand out; you can turn that off per rule or change the default colours.
            </p>
            <p>
              Tags marked <Icon i-mdi-tag-off op100 label="Hide tag" title="Hide tag" /> are hidden themselves — taken
              out of each work's tag list and out of the filter sidebar — without hiding any works.
              Use it for noise tags that only cost you reading time. You can set it from a tag's context menu ("Hide
              this filter"), but removing it again has to be done here.
            </p>
            <p>
              A rule marked <Icon i-mdi-cancel op40 label="Disabled" title="Disabled" /> is disabled: it is kept
              exactly as written — value, matcher, priority and colour — but does nothing at all, and leaves no
              indicator on the page. Use it to put a rule aside without losing it (or the work of writing its regex)
              while you see how the site reads without it. Sorting by the action column brings the disabled rules
              together at the end.
            </p>
            <h2 mt-6 py-1>
              Priority
            </h2>
            <p>
              Every rule carries a priority from 0 to 9. When more than one rule matches a work, the highest priority
              decides whether it is hidden; a tie goes to "always show". The strongest rule left standing also
              decides <em>how</em> the work goes — hidden or collapsed — and there a tie goes to hiding.
              Creating a rule sets the priority its behavior
              implies — 4 for "always show", 0 for everything else — which is why an "always show" beats an ordinary
              hide by default. Raise a hide rule to 5 or more when it should win anyway (say, a fandom you never want
              to see, whatever tags a work carries), or drop an "always show" below 4 to let ordinary hides overrule it.
            </p>
            <p>
              Hiding that isn't a rule at all — the crossover and language filters, and works you've marked read —
              weighs 0, so an "always show" overrules it. Those three don't choose between hiding and collapsing per
              rule either; they all follow the "Collapse or hide" setting above.
            </p>
            <h2 mt-6 py-1>
              Limitations
            </h2>
            <div flex="~ col gap-2">
              <p>
                Note that AO3 enhancements currently has no way to properly resolve <ArchiveLink path="/faq/tags#canonicalhow">wrangled tags</ArchiveLink>.
                You may need to add multiple variants of the "same" tag.
              </p>
              <p>
                Tags of the type `Warning` and `Additional Tag` will <em font="medium">not</em> work if your AO3 account has
                <ArchivePreferenceLink id="hide_warnings" label="Hide warnings" /> and
                <ArchivePreferenceLink id="hide_freeform" label="Hide additional tags" /> preferences enabled respectively.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>

    <OptionRowRulesEditDialog />
  </OptionRowCollapsable>
</template>
