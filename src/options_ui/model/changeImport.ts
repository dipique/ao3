import type { ChangeImportProgress } from '../../content_script/siteExport/importChanges.ts'
import type { JobView } from './jobView.ts'

import { waiting } from './jobView.ts'

/**
 * An import of changes made in an export, as the line under its row shows it.
 *
 * Drawn as a site export job's line is — the same bar, the same countdown, the
 * same striped bar while AO3 refuses us — so a pause in requests to AO3 reads
 * the same wherever the reader meets it. The import reports facts (its step,
 * its count, a deadline); this words them.
 */

/** What the line says at each step. */
export const CHANGE_IMPORT_LINE = {
  applying: 'Applying your marks…',
  archive: 'Marking works read on AO3',
  stopping: 'Stopping…',
} as const

/** What the progress bar is called. */
export const CHANGE_IMPORT_LABEL = 'Importing changes'

/** What a run cut short leaves, whatever cut it short. */
const KEPT_FOR_NEXT_IMPORT = 'Your marks are saved; the works not yet marked read on AO3 are kept, and your next import sends them.'

/** Why an import stopped before AO3 had been told about every work: AO3 kept refusing. */
export const IMPORT_RATE_LIMITED = `AO3 kept asking us to wait, so the import stopped. ${KEPT_FOR_NEXT_IMPORT}`

/** Why an import stopped before AO3 had been told about every work: the reader pressed Stop. */
export const IMPORT_STOPPED = `Stopped. ${KEPT_FOR_NEXT_IMPORT}`

/**
 * The import's line, from its progress; idle with none running. `now` drives
 * the countdown. Once the reader has pressed Stop (`stopping`), the line says
 * so in place of any countdown, until the request already out has finished.
 */
export function changeImportView(progress: ChangeImportProgress | null, now: number, stopping = false): JobView {
  const view: JobView = {
    key: null,
    name: '',
    phase: null,
    label: CHANGE_IMPORT_LABEL,
    state: progress ? 'running' : 'idle',
    done: progress?.done ?? 0,
    total: progress?.total ?? 0,
    line: !progress ? '' : stopping ? CHANGE_IMPORT_LINE.stopping : CHANGE_IMPORT_LINE[progress.step],
    warnings: [],
    failures: { shown: [], more: 0 },
  }
  if (progress && !stopping)
    waiting(view, progress.waitingUntil, progress.waitReason, now)
  return view
}
