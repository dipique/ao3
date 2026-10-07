/**
 * Where a page's runs stand: how many are under way, whether an options change
 * has asked for one that hasn't started, and how many have finished. A run is
 * finished once every unit it ran is ready; work a unit leaves going after that
 * isn't part of it.
 *
 * The content script keeps this on `<html>` ({@link runProgressMarks}), so that
 * a test can wait for the page to be ready rather than for a guessed length of
 * time. Import-free, so it loads under a plain `node --test`.
 */
export interface RunProgress {
  readonly active: number
  readonly asked: boolean
  readonly finished: number
}

/** Before the first run, which the script asks for as it loads. */
export const NO_RUNS: RunProgress = { active: 0, asked: true, finished: 0 }

/** An options change has asked for a run. */
export function runAsked(progress: RunProgress): RunProgress {
  return { ...progress, asked: true }
}

/** A run has started, and reads the options as they stand: whatever was asked for is in it. */
export function runStarted(progress: RunProgress): RunProgress {
  return { ...progress, active: progress.active + 1, asked: false }
}

/** A run has finished, or given up. */
export function runFinished(progress: RunProgress): RunProgress {
  return { ...progress, active: Math.max(0, progress.active - 1), finished: progress.finished + 1 }
}

/**
 * The marks on `<html>`: `data-ao3e-runs`, the runs finished (none before the
 * first), and `data-ao3e-busy`, there while a run is under way or asked for.
 */
export function runProgressMarks(progress: RunProgress): { runs: string | null, busy: boolean } {
  return {
    runs: progress.finished ? String(progress.finished) : null,
    busy: progress.active > 0 || progress.asked,
  }
}
