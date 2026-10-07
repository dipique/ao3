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
