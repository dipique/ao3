<script setup lang="ts">
import { DEFAULT_HIGHLIGHT_COLOR } from '#common'

const { enabled, defaultHighlightColor } = useOption('hideTags')

// Backed by an optional stored value; fall back to the built-in default for
// display so the colour control always has a concrete value to show.
const defaultColor = computed({
  get: () => defaultHighlightColor!.value || DEFAULT_HIGHLIGHT_COLOR,
  set: (v: string) => defaultHighlightColor!.value = v,
})

OptionRowHideTagsContext.provide({
  editDialog: ref(null),
})
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Tags"
    subtitle="Hide tags based on the tags of the work"
  >
    <OptionRowHideTagsTable />

    <label flex="~ items-center gap-3 justify-between" mt-3 text="sm">
      <span flex="~ col gap-0.5">
        <span>Default highlight color</span>
        <span text="xs muted-fg">Used by highlight &amp; force-shown (invert) tag entries without an assigned color.</span>
      </span>
      <ColorInput v-model="defaultColor" />
    </label>

    <OptionRowHideTagsEditDialog />
    <Dialog>
      <DialogTrigger as-child>
        <Button variant="link" mb-2 mt-2>
          Open notes/help on tag filtering.
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>
          Tag filtering notes
        </DialogTitle>
        <DialogDescription class="sr-only">
          Notes on how tag filtering works and its current limitations.
        </DialogDescription>
        <div flex="~ col" class="[&_h2]:text-lg [&_p]:text-sm [&_h2]:font-medium">
          <h2 py-1>
            How to use
          </h2>
          <p>
            Tag filtering works by hiding works that have tags that match the filters you set.
            Filtering works by first hiding works marked as <Icon i-tabler-eye-off op40 label="Hide" title="Hide" />,
            then explicitly unhiding marked as <Icon i-tabler-eye-exclamation op100 label="Show" title="Show" />.
            Tags marked as <Icon i-mdi-star op100 label="Highlight" title="Highlight" /> are instead highlighted on results in a colour of your choice, without changing what is hidden.
            Force-shown (<Icon i-tabler-eye-exclamation op100 label="Show" title="Show" />) tags are highlighted too by default so they stand out; you can turn that off per filter or change the default colour below.
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
  </OptionRowCollapsable>
</template>
