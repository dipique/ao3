import type { Completion, Crossovers } from '#common'
import type { RadioFilter } from '#content_script/radioFilter.js'

import { DefaultSearchFilter } from '#content_script/defaultSearchFilter.js'
import { completionFilter, crossoverFilter } from '#content_script/radioFilter.js'

/**
 * Pre-tick a choice in one of AO3's three-way radio filters. The group's blank
 * radio — "All works", "Include crossovers" — is the one with nothing chosen.
 */
abstract class DefaultSearchRadio<C extends string> extends DefaultSearchFilter<C, HTMLInputElement> {
  protected abstract get filter(): RadioFilter<C>

  protected key(choice: C) { return choice }

  protected controls() {
    const control = this.filter.control(this.root)
    return control ? [control] : []
  }

  protected isSet() { return this.filter.get(this.root) !== null }
  protected apply(_control: HTMLInputElement, choice: C) { return this.filter.set(choice, this.root) }
  protected describe(choice: C) { return this.filter.describe(choice) }
}

/** Pre-tick AO3's Completion Status filter: complete works only, or works in progress only. */
export class DefaultSearchCompletion extends DefaultSearchRadio<Completion> {
  static override get name() { return 'DefaultSearchCompletion' }

  protected get filter() { return completionFilter }

  protected resolve() {
    const { enabled, completion } = this.options.searchCompletion
    return enabled ? completion : null
  }
}

/** Pre-tick AO3's Crossovers filter: leave crossovers out, or show nothing else. */
export class DefaultSearchCrossovers extends DefaultSearchRadio<Crossovers> {
  static override get name() { return 'DefaultSearchCrossovers' }

  protected get filter() { return crossoverFilter }

  protected resolve() {
    const { enabled, crossovers } = this.options.searchCrossovers
    return enabled ? crossovers : null
  }
}
