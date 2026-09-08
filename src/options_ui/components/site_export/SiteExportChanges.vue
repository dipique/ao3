<script setup lang="ts">
import { useFileDialog } from '@vueuse/core'

// Named rather than left to the auto-import, which would make a function from
// this feature's own composable look like one of Vue's globals.
import { describeChangeReport } from '../../composables/useSiteExport.ts'

/**
 * The way back in: a file of marks made inside an exported site, replayed onto
 * this device's mark table.
 *
 * One row for the whole sub-section rather than one per list, because a change
 * file isn't about a list. Every export a reader opens writes to one journal, so
 * what comes back is *their marking*, keyed by work — the list it names is for
 * the report, not for the merge.
 *
 * Two ways in, and the difference is whether AO3 hears about it. Marking a work
 * read also takes it off the reader's Marked for Later list, which is the
 * archive's own behaviour rather than ours and the one part of an import that
 * reaches off this device — so it is the plain button, and declining it is the
 * menu item. Nothing is lost by declining: an op whose archive half didn't
 * happen isn't written down as done, so importing the same file again later
 * picks up exactly those.
 */
const { changeReport, importingChanges, importChanges } = useSiteExport()

/** Which of the two the reader picked, held across the file dialog's round trip. */
const tellArchive = ref(true)

const { open: pickFile, onChange: onFilePicked, reset } = useFileDialog({
  accept: 'application/json',
  multiple: false,
})

onFilePicked(async (files) => {
  const file = files?.[0]
  reset()
  if (file)
    await importChanges(file, { tellArchive: tellArchive.value })
})

function start(archive: boolean): void {
  tellArchive.value = archive
  pickFile()
}

const summary = computed(() => (changeReport.value ? describeChangeReport(changeReport.value) : ''))

/** The per-work detail, which is only ever the parts a reader might act on. */
const problems = computed(() => {
  const report = changeReport.value
  if (!report)
    return []
  return [
    ...report.archiveFailed.map(entry => ({ ...entry, archive: true })),
    ...report.skipped.map(entry => ({ ...entry, archive: false })),
  ]
})

const showProblems = ref(false)
</script>

<template>
  <OptionRow
    title="Changes made in an export"
    subtitle="Marks and reading progress from a site export come back as an ao3e-changes-….json file, saved from the page itself. Import it here to apply them, and to take the works you finished off your Marked for Later list on AO3. Importing the same file twice changes nothing."
  >
    <div flex="~ row items-center">
      <Button
        variant="outline"
        class="disabled:cursor-default !rounded-r-none disabled:op-50"
        :disabled="importingChanges"
        @click.prevent="start(true)"
      >
        {{ importingChanges ? 'Importing…' : 'Import changes' }}
      </Button>
      <DropdownMenu :modal="false">
        <DropdownMenuTrigger>
          <Button
            variant="outline"
            class="-ml-px disabled:cursor-default !rounded-l-none disabled:op-50"
            size="icon"
            :disabled="importingChanges"
          >
            <Icon i-mdi-chevron-down label="More import options" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            flex="~ col items-start gap-1" px-4 py-3
            @click="start(false)"
          >
            <span text-sm font-medium leading-none>Import without telling AO3</span>
            <span line-clamp-2 text-sm text-muted-fg leading-snug>
              Apply the marks here only. Nothing is asked of the Archive, so the works you
              finished stay on your Marked for Later list &mdash; import the same file again
              to send them.
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <template #extra>
      <div v-if="changeReport" flex="~ col gap-1" pt-1>
        <p text="sm muted-fg">
          {{ summary }}
        </p>
        <div v-if="problems.length" flex="~ col gap-1">
          <Button variant="link" self-start p-0 @click.prevent="showProblems = !showProblems">
            {{ problems.length.toLocaleString() }} {{ problems.length === 1 ? 'work needs' : 'works need' }} a look
            <Icon :class="showProblems ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'" ml-1 />
          </Button>
          <ul v-if="showProblems" flex="~ col gap-1" max-h-64 overflow-y-auto text-sm>
            <li v-for="problem in problems" :key="`${problem.workId}-${problem.reason}`" flex="~ col">
              <ArchiveLink :path="`/works/${problem.workId}`">
                Work {{ problem.workId }}
              </ArchiveLink>
              <span text="xs muted-fg">
                {{ problem.archive ? `AO3 would not take it — ${problem.reason}` : problem.reason }}
              </span>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </OptionRow>
</template>
