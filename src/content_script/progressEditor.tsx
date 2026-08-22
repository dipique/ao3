import type { WorkProgress } from '#common'

import { addMonths, ADDON_CLASS, fromEpochDays, todayEpochDays, toEpochDays } from '#common'
import React from '#dom'

import { closeFloating, openPopover } from './contextMenu.tsx'

/**
 * The little form behind "Mark as ongoing…" / "Set wait-until date…": which
 * chapter the reader finished, and (optionally) a date before which the work
 * shouldn't come back.
 *
 * It rides on the same popover layer as the informational hints, with the two
 * concessions a form needs from a thing built to be dismissed on sight — it
 * survives scroll and resize, and it takes focus and gives it back.
 *
 * Two things it deliberately isn't:
 *
 * - **not a `<form>`.** The popover is appended to `document.body` with no
 *   action of its own, so Enter inside a real form would reload the page.
 *   Enter is wired to Save by hand instead.
 * - **not live.** Nothing is written until Save. An `options.set` triggers the
 *   content script's debounced re-run, whose `clean()` removes every `.AO3E`
 *   element — the open popover among them — so a write per keystroke would
 *   close the editor half a second after the reader started typing.
 */

const CLASS = `${ADDON_CLASS}--progress-editor`
const cx = (suffix: string): string => `${CLASS}--${suffix}`

export interface ProgressEditorOptions {
  /** Work title, shown as the editor's heading and used for its accessible name. */
  title: string
  /** The work's current progress, when it already has some. */
  progress?: WorkProgress
  /**
   * Chapters published as far as this page knows. Prefills the chapter field on
   * a listing, where the whole work is all we can see, and caps the field
   * everywhere. Null when the count couldn't be read.
   */
  published: number | null
  /**
   * The chapter open on a work page, when that is where this was opened from.
   * Takes precedence over {@link published}: on a work page you are marking the
   * chapter in front of you, which is the whole reason to mark from there rather
   * than from a listing. Null on a listing, or when it couldn't be read.
   */
  current?: number | null
  /** Where to open, in viewport coordinates. */
  at: { x: number, y: number }
  /** Called with the edited values when the reader saves. */
  onSave: (progress: WorkProgress) => void
}

/** One quick way to fill the date field, relative to today. */
const DATE_PRESETS: { label: string, shift: (today: number) => number }[] = [
  { label: '+1 week', shift: today => today + 7 },
  { label: '+1 month', shift: today => addMonths(today, 1) },
  { label: '+3 months', shift: today => addMonths(today, 3) },
]

/** Open the chapter/wait-until editor for one work. */
export function openProgressEditor(opts: ProgressEditorOptions): void {
  const today = todayEpochDays()
  // An existing mark keeps whatever it recorded. Otherwise: on a work page the
  // chapter you have open is where you are, and on a listing the best guess is
  // that you have caught up on what is published.
  const startChapter = opts.progress?.chapter ?? opts.current ?? opts.published ?? 0

  const chapterInput = (
    <input
      type="number"
      min="0"
      inputmode="numeric"
      class={`${cx('input')}  ${cx('chapter')}`}
      id={`${cx('chapter')}-input`}
    />
  ) as HTMLElement as HTMLInputElement
  chapterInput.value = String(startChapter)
  if (opts.published !== null)
    chapterInput.max = String(opts.published)

  const dateInput = (
    <input type="date" class={`${cx('input')}  ${cx('date')}`} id={`${cx('date')}-input`} />
  ) as HTMLElement as HTMLInputElement
  // No date yet starts at today rather than blank, so the relative presets have a
  // visible base to move from — "+1 month" reads as a month from *this*, not as a
  // value appearing out of an empty field. Today means "ready now", which is what
  // no date meant anyway; Clear puts it back to genuinely unset.
  dateInput.value = fromEpochDays(opts.progress?.waitUntil ?? today)

  const presets = DATE_PRESETS.map(({ label, shift }) => {
    const btn = (<button type="button" class={cx('preset')}>{label}</button>) as HTMLElement as HTMLButtonElement
    btn.addEventListener('click', () => {
      dateInput.value = fromEpochDays(shift(today))
    })
    return btn
  })
  const clearDate = (
    <button type="button" class={cx('preset')} title="Remove the wait-until date">Clear</button>
  ) as HTMLElement as HTMLButtonElement
  clearDate.addEventListener('click', () => {
    dateInput.value = ''
  })

  const save = (): void => {
    // A blank or nonsense chapter reads as 0 ("marked, nothing read yet") rather
    // than refusing to save — there's no wrong answer here worth an error for.
    const chapter = Math.max(0, Math.trunc(Number(chapterInput.value.replace(/\D/g, ''))) || 0)
    // "Wait until today" is precisely what "no wait-until date" means — both say
    // the work is ready now — so today is stored as no date at all. That is what
    // lets the field default to today for the presets' sake without every mark
    // then carrying a date it never actually needed, and it keeps the hint
    // reading "no Wait Until date set" for the works that have none.
    const parsed = toEpochDays(dateInput.value)
    const waitUntil = parsed === null || parsed === today ? null : parsed
    closeFloating()
    opts.onSave(waitUntil === null ? { chapter } : { chapter, waitUntil })
  }

  const saveBtn = (<button type="button" class={cx('save')}>Save</button>) as HTMLElement as HTMLButtonElement
  saveBtn.addEventListener('click', save)
  const cancelBtn = (<button type="button" class={cx('cancel')}>Cancel</button>) as HTMLElement as HTMLButtonElement
  cancelBtn.addEventListener('click', () => closeFloating())

  const body = (
    <div class={CLASS}>
      <div class={cx('title')}>{opts.title}</div>
      <div class={cx('field')}>
        <label class={cx('label')} htmlFor={chapterInput.id}>Last finished chapter</label>
        {chapterInput}
        {opts.published !== null
          ? <div class={cx('note')}>{`${opts.published} published so far`}</div>
          : null}
      </div>
      <div class={cx('field')}>
        <label class={cx('label')} htmlFor={dateInput.id}>Wait until (optional)</label>
        {dateInput}
        <div class={cx('presets')}>
          {presets}
          {clearDate}
        </div>
      </div>
      <div class={cx('actions')}>
        {cancelBtn}
        {saveBtn}
      </div>
    </div>
  ) as HTMLElement

  // Enter saves from either field — the affordance a real <form> would have
  // given us, without the page reload it would also have given us.
  body.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      e.preventDefault()
      save()
    }
  })

  openPopover(body, opts.at, {
    persistent: true,
    size: 'form',
    label: `Ongoing progress for ${opts.title}`,
    autoFocus: chapterInput,
  })
}
