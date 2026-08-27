import type { BaseLogger, Options } from '#common'

import { logger } from '#common'

export class Unit {
  options: Options
  /**
   * DOM subtree a unit scans in `ready()`. Defaults to the whole document (the
   * normal page-load run); the Marked-for-Later search view passes its results
   * container so the same blurb enhancements can decorate freshly scraped works.
   */
  protected root: ParentNode

  constructor(options: Options, root: ParentNode = document) {
    this.options = options
    this.root = root
  }

  static get logger(): BaseLogger { return logger.child(this.name) }
  get logger(): BaseLogger { return (this.constructor as typeof Unit).logger }
  static get name(): string { return 'Unit' }
  get name(): string { return (this.constructor as typeof Unit).name }

  static async clean(): Promise<void> {}

  get enabled(): boolean { return false }
  async ready(): Promise<void> {}
}
