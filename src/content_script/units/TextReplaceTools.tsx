import MdiFindReplace from '~icons/mdi/find-replace.jsx'

import { ADDON_CLASS } from '#common'
import { extensionAlive } from '#content_script/extensionAlive.js'
import { openTextReplaceEditor } from '#content_script/textReplaceEditor.js'
import { REPLACED_CLASS, REPLACED_RULE_ATTR } from '#content_script/textReplaceMarks.ts'
import { findWorkText, isInWorkText } from '#content_script/textReplaceScope.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const BUTTON_CLASS = `${ADDON_CLASS}--replace-selection`

/** Kept clear of the selection so the button never covers what was selected. */
const SELECTION_GAP = 6
/** Clamping margin, matching the floating layer's own. */
const VIEWPORT_MARGIN = 6

/**
 * Everything one run set up, at module scope so the static `clean()` — which
 * runs before every re-run — can take it all down again. The button itself
 * carries `ADDON_CLASS`, so the page-wide sweep removes it either way; what has
 * to be undone by hand are the listeners, which outlive their element.
 */
let detach: Array<() => void> = []

function teardown(): void {
  detach.forEach(fn => fn())
  detach = []
}

/**
 * The work page's text-replacement tools: a way to write a replacement rule from
 * the work you are reading, and a way back to one you already wrote.
 *
 * - **Select to replace.** Selecting any of the work's own text — the same scope
 *   the replacements themselves apply to, summary and notes included — puts a
 *   small button beside the selection. It opens the rule editor with the
 *   selected words already in Find.
 * - **Click to edit.** Every run of text a rule replaced is underlined (the
 *   spans are written by {@link file://./TextReplace.ts}); clicking one opens
 *   that rule, to change, disable or delete.
 *
 * Both are gated on `textReplacements.tools`, which the reader can turn on and
 * off from the options page or from the floating toolbar without leaving the
 * work — the underlining is a reading aid while you are setting rules up, and a
 * distraction once you have.
 *
 * The underlines are clickable but not focusable on purpose: a long work can
 * hold hundreds of replaced runs, and putting each one in the tab order would
 * make the work unreadable by keyboard for the sake of an edit shortcut. The
 * options page is the route that stays open to everyone.
 */
export class TextReplaceTools extends Unit {
  static override get name() { return 'TextReplaceTools' }

  override get enabled() {
    return this.options.textReplacements.enabled && this.options.textReplacements.tools
  }

  static override async clean(): Promise<void> {
    teardown()
  }

  override async ready(): Promise<void> {
    const root = findWorkText()
    if (!root) {
      this.logger.debug('No work text on this page; no replacement tools to add.')
      return
    }

    teardown()
    this.watchSelection(root)
    this.watchReplacedRuns(root)
    this.logger.debug('Text replacement tools ready.')
  }

  /** Clicking a run some rule replaced opens that rule. */
  private watchReplacedRuns(root: Element): void {
    // Read once per run: an edit writes a setting, which re-runs the content
    // script, which rebuilds both the spans and this listener from the new list.
    const rules = this.options.textReplacements.rules

    const onClick = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element))
        return
      const span = target.closest(`.${REPLACED_CLASS}`)
      if (!span)
        return

      // A click that ended a drag-select is the reader selecting text, not
      // asking to edit; leave that to the selection button.
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed)
        return

      const index = Number(span.getAttribute(REPLACED_RULE_ATTR))
      const rule = rules[index]
      if (!rule)
        return

      // The run may sit inside a link, and this is not a click on the link.
      event.preventDefault()
      event.stopPropagation()

      // Nothing the editor could do from here would stick, and the rule it
      // would show was read from settings this page can no longer see.
      if (!extensionAlive())
        return

      const rect = span.getBoundingClientRect()
      openTextReplaceEditor({
        rule: { ...rule },
        index,
        at: { x: rect.left, y: rect.bottom + SELECTION_GAP },
      })
    }

    root.addEventListener('click', onClick)
    detach.push(() => root.removeEventListener('click', onClick))
  }

  /** Selecting some of the work's text offers to make a rule out of it. */
  private watchSelection(root: Element): void {
    const button: HTMLButtonElement = (
      <button
        type="button"
        class={`${ADDON_CLASS}  ${BUTTON_CLASS}`}
        title="Add a text replacement for the selected text"
        aria-label="Add a text replacement for the selected text"
      >
        <MdiFindReplace />
        <span>Replace…</span>
      </button>
    ) as HTMLElement as HTMLButtonElement

    /**
     * The selection the button is currently offering, where it was, and whether
     * it spanned more than one text node — see `crosses` below.
     */
    let selected: { text: string, at: { x: number, y: number }, crosses: boolean } | null = null
    /** A pointer is on the button — a selection lost to that press isn't a dismissal. */
    let hovering = false

    const hide = (): void => {
      if (hovering)
        return
      selected = null
      button.remove()
    }

    const place = (rect: DOMRect): { x: number, y: number } => {
      // Below the end of the selection, then clamped like any floating element.
      button.style.visibility = 'hidden'
      if (!button.isConnected)
        document.body.append(button)
      const size = button.getBoundingClientRect()
      const x = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.right - size.width / 2, window.innerWidth - size.width - VIEWPORT_MARGIN),
      )
      const y = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.bottom + SELECTION_GAP, window.innerHeight - size.height - VIEWPORT_MARGIN),
      )
      button.style.left = `${x}px`
      button.style.top = `${y}px`
      button.style.visibility = ''
      return { x, y }
    }

    const sync = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0)
        return hide()

      const range = selection.getRangeAt(0)
      const text = range.toString().trim()
      if (!text)
        return hide()
      if (!isInWorkText(range.startContainer, root) || !isInWorkText(range.endContainer, root))
        return hide()

      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0)
        return hide()

      // A selection that started in one text node and ended in another has
      // picked up text either side of a change of formatting, and a rule made
      // from it can only ever match with `acrossFormatting` set. Nobody finds a
      // flag that explains why their rule quietly does nothing, so the one
      // moment we can tell them is this one — the rule opens with it ticked.
      const crosses = range.startContainer !== range.endContainer
      selected = { text, at: place(rect), crosses }
    }

    // Coalesced to one pass per frame: `selectionchange` fires continuously
    // while a selection is being dragged out.
    let pending = false
    const schedule = (): void => {
      if (pending)
        return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        sync()
      })
    }

    const onScrollOrResize = (): void => {
      if (selected)
        schedule()
    }

    // Keeps the selection alive through the press that opens the editor: without
    // this the browser clears it on mousedown and there is nothing left to
    // prefill Find with.
    button.addEventListener('mousedown', e => e.preventDefault())
    button.addEventListener('pointerenter', () => hovering = true)
    button.addEventListener('pointerleave', () => hovering = false)
    button.addEventListener('click', (e) => {
      e.preventDefault()
      const current = selected
      if (!current)
        return
      hovering = false
      hide()
      // Checked before the editor opens rather than at Save: a rule typed into
      // a form that cannot write it is a minute of the reader's time thrown
      // away, and they'd have no way of knowing why.
      if (!extensionAlive())
        return
      openTextReplaceEditor({
        rule: {
          find: current.text,
          replace: '',
          caseSensitive: false,
          matchCasing: false,
          wholeWord: false,
          acrossFormatting: current.crosses,
        },
        index: null,
        at: current.at,
      })
    })

    document.addEventListener('selectionchange', schedule)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    detach.push(() => {
      document.removeEventListener('selectionchange', schedule)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
      button.remove()
    })

    // A selection can already be in place when a re-run rebuilds the tools.
    sync()
  }
}
