import { attachReaderSizing } from '#content_script/readerSizing.ts'
import { Unit } from '#content_script/Unit.js'

/**
 * ReaderMode — makes the work text (`#workskin`) comfortable to resize: a zoom
 * gesture over it changes its font size, and handles on its edges drag its width
 * ({@link file://../readerSizing.ts}). The `readerMode` option is just the on/off
 * switch.
 *
 * The one active instance's teardown is kept at module scope so the static
 * `clean()` (which runs before every re-run) can fully remove it — re-runs
 * depend on `clean()` leaving no trace: our listeners, handles and the inline
 * styles we put on `#workskin`.
 */
let detach: (() => void) | null = null

function teardown(): void {
  detach?.()
  detach = null
}

export class ReaderMode extends Unit {
  static override get name() { return 'ReaderMode' }
  override get enabled() { return this.options.readerMode }

  static override async clean(): Promise<void> {
    teardown()
  }

  override async ready(): Promise<void> {
    const workskin = document.querySelector<HTMLElement>('#workskin')
    if (!workskin) {
      // Not a work page — nothing to enhance.
      return
    }

    // Defensive: a previous instance should already be gone via clean().
    teardown()

    const sizing = attachReaderSizing(workskin)
    detach = sizing.detach
    this.logger.debug(`Reader mode active (scale ${sizing.scale.toFixed(2)}, width ${sizing.widthRem.toFixed(1)}rem).`)
  }
}
