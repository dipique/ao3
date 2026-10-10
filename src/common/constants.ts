export const ADDON_CLASS = 'AO3E'

/** How long the "update results" prompt stays up on its own, in milliseconds. */
export const SEARCH_PROMPT_TIMEOUT = 3000

/** How long a list saved back from the floating toolbar can be put back as it was, from its toast, in milliseconds. */
export const SAVE_BACK_UNDO_TIMEOUT = 20_000

/**
 * How soon after one of the extension's menus opens another may, in
 * milliseconds: a right-click and a long-press made as one physical gesture
 * open one menu.
 */
export const REOPEN_GUARD_MS = 250

/**
 * How long the options page gives the background to say which build it runs
 * before taking it to be out of date, in milliseconds: a background from
 * before the question was asked never answers.
 */
export const BUILD_CHECK_TIMEOUT_MS = 5000

/**
 * How long the options page waits after an edit before saving, in
 * milliseconds: every option changed within it is saved together.
 */
export const OPTIONS_SAVE_DELAY_MS = 200

/**
 * Where the site export's job is kept. Outside the `cache.` prefix: a
 * half-finished job is not a cache, and has no business travelling in an export.
 */
export const SITE_EXPORT_JOB_KEY = 'siteExportJob'

/**
 * How long a synced copy that can't be read whole is waited on, in
 * milliseconds, from when this browser first read it so: until then another
 * browser is taken to be still sending it. Firefox syncs extension storage
 * every ten minutes, so this is two of its rounds: the sender's next, which
 * carries the rest, and the reader's after it. Chrome names no delay, and
 * sends an offline browser's changes once it is back.
 */
export const SYNC_CONSISTENCY_WAIT_MS = 20 * 60_000

/**
 * How long the rule editor lets a regex pattern run over the names it tests
 * before stopping it, in milliseconds. A pattern stopped for running longer
 * can't be saved: on AO3's pages nothing stops it.
 */
export const REGEX_TIME_BUDGET_MS = 1000
