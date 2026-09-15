import { createLogger, syncMeta } from '#common'

const logger = createLogger('Build')

/**
 * Whether this background is running the build that's on disk.
 *
 * An unpacked extension's manifest version never changes between builds, and
 * Chrome can go on serving the service worker it cached for one — through
 * rebuilds and browser restarts alike — until someone reloads the extension.
 * Pages and content scripts come fresh from disk meanwhile, so nothing looks
 * wrong, while the background keeps syncing with code that may not know options
 * the rest of the extension writes.
 *
 * The builder stamps one id into every bundle and into `build.json` beside the
 * manifest. A mismatch records `syncMeta.staleBuild`, which stops sync, and
 * reloads the extension once for that on-disk build; if Chrome still serves the
 * old worker afterwards, sync stays stopped and the options page says why.
 */
export async function checkBuild(): Promise<boolean> {
  const running = process.env.BUILD_ID
  let onDisk: string | undefined
  try {
    const response = await fetch(browser.runtime.getURL('build.json'))
    onDisk = ((await response.json()) as { buildId?: string }).buildId
  }
  catch (error) {
    // A packed install always matches, so this is a read that failed, not news.
    logger.warn('Could not read build.json', error)
    return true
  }

  if (!onDisk || onDisk === running) {
    if (await syncMeta.get('staleBuild'))
      await syncMeta.set({ staleBuild: null })
    return true
  }

  await syncMeta.set({ staleBuild: { running, onDisk } })
  if (await syncMeta.get('reloadAttemptedFor') !== onDisk) {
    await syncMeta.set({ reloadAttemptedFor: onDisk })
    logger.warn(`Running build ${running}, but ${onDisk} is on disk. Reloading.`)
    browser.runtime.reload()
  }
  else {
    logger.error(`Still running build ${running} after reloading for ${onDisk}. Sync is paused until the extension is reloaded.`)
  }
  return false
}
