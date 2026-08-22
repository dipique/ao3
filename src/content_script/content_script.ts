import { debounce } from '@antfu/utils'

import { ADDON_CLASS, api, isExtensionContextValid, logger, options, toast } from '#common'

import { setMenusEnabled } from './contextTrigger.tsx'
import { applySurfaceTheme } from './theme.ts'
import { UNITS } from './units/index.ts'
import { getTag } from './utils.tsx'

/**
 * Clears any old DOM elements added by the extension.
 */
async function clean() {
  logger.info('Cleaning up...')

  await Promise.all(UNITS.map(u => u.clean()))

  const toRemove = document.querySelectorAll(`.${ADDON_CLASS}`)
  if (toRemove.length) {
    logger.debug('Removing old elements: ', toRemove)
    toRemove.forEach((el) => {
      el.remove()
    })
  }
}

async function run() {
  // Bail before touching the page if the extension was reloaded, updated, or
  // disabled under this tab. Storage answers from defaults once that happens
  // (see `#common/extensionContext`), so re-running here would re-render every
  // unit with default settings — silently undoing the reader's filters on a page
  // that looked fine a moment ago. Leaving the page as-is is the honest option;
  // a reload reconnects it.
  if (!isExtensionContextValid()) {
    logger.warn('Extension context is gone (reloaded or updated) — leaving this page as it is. Reload to reconnect.')
    return
  }

  const opts = await options.get()
  // Seed the context-menu enable flag before any unit decorates the page.
  setMenusEnabled(opts.contextMenusEnabled)
  const units = UNITS.map(U => new U(opts))
  const enabled = units.filter(u => u.enabled)

  logger.info('Enabled units:', enabled.map(u => u.name))

  if (document.readyState !== 'loading') {
    await clean()
  }
  else {
    await waitForReady()
  }

  // The floating-surface palette. Our menu/popover/toast are drawn entirely by
  // us, so they have to be told which skin they're sitting on — and that reads
  // the body's computed background, so it can only be measured once the body
  // exists and AO3's stylesheet has applied. Hence here, not at the top of the
  // run: at `document_start` there is no body to sample.
  applySurfaceTheme(opts.theme?.chosen)

  await Promise.all(enabled.map(u => u.ready()))
}

function waitForReady(): Promise<void> {
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve())
  })
}

const debouncedRun = debounce(500, () => {
  run().catch((err) => {
    logger.error(err)
  })
})

options.addListener(() => {
  logger.info('Options have changed, reloading.')
  debouncedRun()
})

api.getTag.addListener(async (linkUrl) => {
  return getTag(linkUrl)
})

api.toast.addListener(async (...args) => {
  toast(...args)
})

run().catch((err) => {
  logger.error(err)
})
