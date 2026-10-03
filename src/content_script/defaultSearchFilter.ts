import { searchFilterChanged } from '#content_script/pendingSearch.js'
import { Unit } from '#content_script/Unit.js'

/**
 * The default each control has already been offered, keyed by the element that
 * stands for the control, so it is offered once.
 *
 * Every options change re-runs every unit — a rule picked from a context menu
 * included — and a reader who cleared the control and hasn't searched yet would
 * otherwise find the default quietly put back. So a control only takes the
 * default the first time a unit sees it with that default to give. Keyed by the
 * default rather than a plain seen-set so that changing the setting itself still
 * reaches an open page: that is a new instruction, not a re-run of the old one.
 */
const offered = new WeakMap<Element, string>()

/**
 * A unit that fills one of AO3's own Sort & Filter controls with a default from
 * the options — on works and bookmark listings, and on the advanced search page —
 * so browsing starts from the filters you always want, without picking them each
 * time.
 *
 * Only a control with nothing chosen yet is filled, so a choice already made —
 * by the reader, or carried in the page URL — is left alone. We only set the
 * control and say so ({@link searchFilterChanged}); the reader runs the search.
 */
export abstract class DefaultSearchFilter<T, C extends Element = Element> extends Unit {
  /** The default to offer, or null when the options don't ask for one. */
  protected abstract resolve(): T | null
  /** Tells one default from another, so a changed setting is offered afresh. */
  protected abstract key(value: T): string
  /** The elements standing for this filter's controls on the page — usually one. */
  protected abstract controls(): C[]
  /** Whether the control already holds a choice. */
  protected abstract isSet(control: C): boolean
  /** Write the default into the control; false when it can't take it. */
  protected abstract apply(control: C, value: T): boolean
  /** What the pending-search prompt says once the default is in. */
  protected abstract describe(value: T): string

  override get enabled(): boolean {
    return this.resolve() !== null
  }

  override async ready(): Promise<void> {
    const value = this.resolve()
    if (value === null)
      return

    const key = this.key(value)
    let applied = 0
    for (const control of this.controls()) {
      if (offered.get(control) === key)
        continue
      offered.set(control, key)
      if (!this.isSet(control) && this.apply(control, value))
        applied++
    }

    if (applied > 0) {
      this.logger.debug(`Defaulted ${applied} control(s).`, value)
      searchFilterChanged(this.describe(value))
    }
  }
}
