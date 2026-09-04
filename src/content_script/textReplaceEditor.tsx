import type { TextReplacement } from '#common'

import { ADDON_CLASS, options, toast } from '#common'
import React from '#dom'

import { closeFloating, openPopover } from './contextMenu.tsx'

/**
 * The find/replace rule editor, as it appears on the work page itself.
 *
 * Same fields as the options page's Text replacement list, reached two ways: by
 * selecting some of the work's text and pressing the button that appears beside
 * it (a new rule, with the selection filled in), or by clicking a run of text a
 * rule already replaced (that rule, with a Delete beside Save). See
 * {@link file://./units/TextReplaceTools.tsx} for both triggers.
 *
 * It rides on the popover layer, with the concessions a form needs from a
 * surface built to be dismissed on sight — it survives scroll and resize, and it
 * takes focus and gives it back. Like the progress editor it is deliberately not
 * a `<form>` (Enter is wired to Save by hand, since a real form appended to
 * `document.body` would reload the page) and deliberately not live: writing a
 * setting triggers the content script's debounced re-run, whose clean-up takes
 * the open popover with it, so nothing is saved until Save is pressed.
 */

const CLASS = `${ADDON_CLASS}--replace-editor`
const cx = (suffix: string): string => `${CLASS}--${suffix}`

export interface TextReplaceEditorOptions {
  /** The rule to edit — a fresh draft when adding. */
  rule: TextReplacement
  /**
   * Where the rule sits in `options.textReplacements.rules`, or `null` when it
   * is not in the list yet. Having an index is also what makes Delete available.
   */
  index: number | null
  /** Where to open, in viewport coordinates. */
  at: { x: number, y: number }
}

/** One of the rule's flags, as a labelled checkbox. */
function checkbox(label: string, checked: boolean, hint: string): { row: HTMLElement, input: HTMLInputElement } {
  const input = (<input type="checkbox" class={cx('checkbox')} />) as HTMLElement as HTMLInputElement
  input.checked = checked
  const row = (
    <label class={cx('check')} title={hint}>
      {input}
      <span>{label}</span>
    </label>
  ) as HTMLElement
  return { row, input }
}

/** Write `rule` back into the reader's settings — replacing entry `index`, or appending. */
async function saveRule(index: number | null, rule: TextReplacement): Promise<void> {
  const current = await options.get('textReplacements')
  const rules = [...current.rules]
  if (index === null || index >= rules.length)
    rules.push(rule)
  else
    rules[index] = rule
  await options.set({ textReplacements: { ...current, rules } })
}

/** Drop entry `index` from the reader's settings. */
async function deleteRule(index: number): Promise<void> {
  const current = await options.get('textReplacements')
  const rules = current.rules.filter((_, at) => at !== index)
  await options.set({ textReplacements: { ...current, rules } })
}

/** Open the editor for one replacement rule. */
export function openTextReplaceEditor(opts: TextReplaceEditorOptions): void {
  const { rule, index } = opts
  const editing = index !== null

  const findInput = (
    <input type="text" class={`${cx('input')}  ${cx('find')}`} id={`${cx('find')}-input`} spellcheck={false} />
  ) as HTMLElement as HTMLInputElement
  findInput.value = rule.find

  const replaceInput = (
    <input type="text" class={`${cx('input')}  ${cx('replace')}`} id={`${cx('replace')}-input`} spellcheck={false} />
  ) as HTMLElement as HTMLInputElement
  replaceInput.value = rule.replace

  const caseSensitive = checkbox('Case sensitive', !!rule.caseSensitive, 'Match only where the capitalisation matches exactly.')
  const matchCasing = checkbox('Match casing', !!rule.matchCasing, 'Match any capitalisation, and capitalise the replacement when the match starts with a capital.')
  const wholeWord = checkbox('Whole word', !!rule.wholeWord, 'Match only whole words.')
  const disabled = checkbox('Disabled', !!rule.disabled, 'Keep the rule but stop it applying.')

  // "Match casing" is what to do about capitalisation when the match ignores it,
  // so it has nothing to say once the match is case-sensitive.
  const syncCasing = (): void => {
    matchCasing.input.disabled = caseSensitive.input.checked
    matchCasing.row.classList.toggle(cx('check--off'), caseSensitive.input.checked)
  }
  caseSensitive.input.addEventListener('change', syncCasing)
  syncCasing()

  const error = (<div class={cx('error')} role="alert" hidden />) as HTMLElement

  const save = (): void => {
    const find = findInput.value
    if (!find) {
      error.textContent = 'Enter some text to find.'
      error.hidden = false
      findInput.focus()
      return
    }

    const next: TextReplacement = {
      find,
      replace: replaceInput.value,
      caseSensitive: caseSensitive.input.checked,
      matchCasing: matchCasing.input.checked,
      wholeWord: wholeWord.input.checked,
      disabled: disabled.input.checked,
    }

    closeFloating()
    void saveRule(index, next).then(() => {
      toast(editing ? 'Replacement updated' : 'Replacement added', { type: 'success' })
    })
  }

  const remove = (): void => {
    if (index === null)
      return
    closeFloating()
    void deleteRule(index).then(() => {
      toast('Replacement deleted', { type: 'success' })
    })
  }

  const saveBtn = (<button type="button" class={cx('save')}>Save</button>) as HTMLElement as HTMLButtonElement
  saveBtn.addEventListener('click', save)
  const cancelBtn = (<button type="button" class={cx('cancel')}>Cancel</button>) as HTMLElement as HTMLButtonElement
  cancelBtn.addEventListener('click', () => closeFloating())
  const deleteBtn = editing
    ? (<button type="button" class={cx('delete')} title="Remove this replacement">Delete</button>) as HTMLElement as HTMLButtonElement
    : null
  deleteBtn?.addEventListener('click', remove)

  const body = (
    <div class={CLASS}>
      <div class={cx('title')}>{editing ? 'Edit replacement' : 'New replacement'}</div>
      <div class={cx('field')}>
        <label class={cx('label')} htmlFor={findInput.id}>Find</label>
        {findInput}
      </div>
      <div class={cx('field')}>
        <label class={cx('label')} htmlFor={replaceInput.id}>Replace with</label>
        {replaceInput}
      </div>
      <div class={cx('checks')}>
        {caseSensitive.row}
        {matchCasing.row}
        {wholeWord.row}
        {disabled.row}
      </div>
      {error}
      <div class={cx('note')}>
        Only what is shown changes; the work itself is untouched.
      </div>
      <div class={cx('actions')}>
        {deleteBtn}
        {cancelBtn}
        {saveBtn}
      </div>
    </div>
  ) as HTMLElement

  // Enter saves from any text field — the affordance a real <form> would have
  // given us, without the page reload it would also have given us.
  body.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') {
      e.preventDefault()
      save()
    }
  })

  openPopover(body, opts.at, {
    persistent: true,
    size: 'form',
    label: editing ? 'Edit text replacement' : 'New text replacement',
    // A new rule opens with the selection already in Find, so the field worth
    // landing in is the one the reader still has to fill.
    autoFocus: editing || !rule.find ? findInput : replaceInput,
  })
}
