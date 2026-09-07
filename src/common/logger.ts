type ConsoleFunc = (...args: unknown[]) => void

const C = globalThis.console

export class Logger {
  static verbose = true

  prefix: string[]

  constructor(prefix: string[]) {
    this.prefix = prefix
  }

  get log(): ConsoleFunc { return (Logger.verbose ? C.log.bind(C, ...this.prefix) : () => { /* ignore */ }) }
  get debug(): ConsoleFunc { return (Logger.verbose ? C.debug.bind(C, ...this.prefix) : () => { /* ignore */ }) }
  get info(): ConsoleFunc { return C.info.bind(C, ...this.prefix) }
  get warn(): ConsoleFunc { return C.warn.bind(C, ...this.prefix) }
  get error(): ConsoleFunc { return C.error.bind(C, ...this.prefix) }

  child(name: string, formatting = 'color: #fff7;'): Logger {
    return new Logger([`${this.prefix[0]}%c %c${name}`, ...this.prefix.slice(1), '', formatting])
  }
}

export const logger = new Logger(['%c[AO3E]', 'color: #fff3;'])
export function createLogger(...args: Parameters<Logger['child']>): ReturnType<Logger['child']> {
  return logger.child(...args)
}

/**
 * The name-and-version badge each context prints once, on its way up.
 *
 * Called by an entry point rather than run when `#common` is imported. The
 * barrel used to read the manifest at import time, which made every module in
 * it — the pure ones included — unusable anywhere the extension APIs aren't
 * there to answer.
 */
export function logBanner(): void {
  const manifest = browser.runtime.getManifest()
  createLogger(
    `${manifest.short_name} v${manifest.version}`,
    'display: inline-block; background-color: #e0005a; color: #ffffff; font-weight: bold; padding: 1px 3px; border-radius: 3px;',
  ).info()
}

void browser.storage.local.get('option.verbose').then((value) => {
  Logger.verbose = (value['option.verbose'] as boolean | undefined) ?? false
})
