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
    subtitle="Tag-based rules to hide, collapse, or show works; and rules that hide or highlight specific tags. A 'tag' can be be a tag, fandom, author, warning, character, relationship, or work/series title. Rules have priorities to resolve conflicts. That means you can hide a fandom by default, but have works display if a certain tag is present."
  >
    <OptionRowRulesList />

    <div flex="~ items-center gap-3 justify-between" mt-3>
      <OptionRowRuleColors />
      <Dialog>
        <DialogTrigger as-child>
          <Button variant="link" text="[12px]!">
            How rules work
          </Button>
        </DialogTrigger>
        <DialogContent size="lg">
          <DialogTitle>
            Rules notes
          </DialogTitle>
          <DialogDescription class="sr-only">
            Rules and how to use them
          </DialogDescription>
          <div flex="~ col" class="[&_h2]:text-lg [&_p]:text-sm [&_h2]:font-medium">
            <h2 py-1>
              How to use
            </h2>
            <p>
              Each rule says what it applies to; a specific type of tag (e.g., character or author), all tags (matches any tag except author), or the title of the work or series. Matches must be exact by default, but can be set to use "contains" instead (matches if the tag contains your text), or using special matching logic using regular expressions. "Additional tags" is the type that refers to a "tag" as most people think of them.
            </p>

            <h2 py-1>
              Rule Actions
            </h2>
            <p>
              Each rule specifies an action to take if it matches a work:
              <ul>
                <li><Icon i-tabler-eye-off op40 label="Hide" title="Hide" /> (Hide): hides the listing entirely</li>
                <li><Icon i-mdi-arrow-collapse-vertical op60 label="Collapse" title="Collapse" /> (Collapse): the work stays, but collapsed so you can look at it if you want</li>
                <li><Icon i-tabler-eye-exclamation op100 label="Show" title="Show" /> (Show): Works matched by are shown when something else would hide them (based on rule priority)</li>
                <li><Icon i-mdi-star op100 label="Highlight" title="Highlight" /> (Highlight): Highlights the tag for visibility; each rule can be assigned a different color</li>
                <li><Icon i-tabler-eye-exclamation op100 label="Show" title="Show" /> (Force Show): Matching tags are highlighted and the work is shown even if another rule hides it unless that rule has a higher priority</li>
                <li><Icon i-mdi-tag-off op100 label="Hide tag" title="Hide tag" /> (Hide 'Useless' Tag): Hides the tag itself without affecting the visibility of the work</li>
                <li><Icon i-mdi-cancel op40 label="Disabled" title="Disabled" /> (Disabled): Temporarily stops a rule from applying without deleting it; set by untoggling the "enabled" button at the bottom of the rule dialog</li>
              </ul>
            </p>
            
            <h2 py-1>
              Priority
            </h2>
            <p>
              Rules carry a priority from 0 to 9. When multiple rules apply that affect visibility, the highest priority decides whether it is hidden. "Always show" wins ties, then "Hide", then "Collapse".
            </p>
            <br />
            <p>
              When works are hidden for reasons other than rules (like the crossover filter or items already marked as read), that "rule" is given a weight of 0 for the purposes of rule conflicts.
            </p>

            <h2 py-1>
              Limitations
            </h2>
            <div flex="~ col gap-2">
              <p>
                Tags of the type `Warning` and `Additional Tag` will <em font="medium">not</em> work if your AO3 account has <ArchivePreferenceLink id="hide_warnings" label="Hide warnings" /> and <ArchivePreferenceLink id="hide_freeform" label="Hide additional tags" /> preferences enabled respectively.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>

    <OptionRowRulesEditDialog />
  </OptionRowCollapsable>
</template>
