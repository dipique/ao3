/**
 * Anchors: what a category, sub-section or settings row is known by. Each has
 * a key of its own, written beside it on the page, which is its DOM id, what a
 * `#hash` and a bookmark name, and what tests find it by. A key never comes
 * from a title, so a setting can be renamed, or its description reworded,
 * without moving a link, a bookmark or a test. A row's key is the option it
 * sets, where it sets one.
 */

/**
 * How a `#hash` is read before it is looked up: lowercase words joined by
 * hyphens, accents and apostrophes dropped. Deliberately not `kebabCase`,
 * which splits on case boundaries and turns "Compress filter URLs" into
 * `compress-filter-ur-ls`.
 */
export function anchorSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Whether `key` is written as a hash is read ({@link anchorSlug}), so a link to it finds it. */
export function isAnchorKey(key: string): boolean {
  return key !== '' && anchorSlug(key) === key
}

/** Other ids a row answers to, each leading to its key, for the links and bookmarks that name a row by one of them. */
export const ANCHOR_ALIASES: Readonly<Record<string, string>> = {
  'link-menus-right-click-menus': 'context-menus',
  'link-menus-open-menus-with-a-left-click': 'open-menu-on-click',
  'link-menus-menu-on-tags': 'tag-toolbar',
  'link-menus-menu-on-fandoms': 'fandom-toolbar',
  'link-menus-hide-or-highlight-an-author': 'hide-author-toolbar',
  'link-menus-subscribe-to-an-author': 'subscribe-author-toolbar',
  'link-menus-mute-an-author': 'mute-author-toolbar',
  'link-menus-mark-a-work-for-later': 'mark-for-later-toolbar',
  'page-controls-reveal-filtered-works': 'filter-toolbar',
  'page-controls-collapsible-dashboard-sidebar': 'collapsible-dashboard',
  'appearance-extension-theme': 'theme',
  'appearance-dark-skin-for-ao3': 'dark-skin',
  'appearance-show-statistics-in-columns': 'show-stats-columns',
  'appearance-hide-muted-author-notices': 'hide-muted-author-notices',
  'filter-defaults-default-language': 'search-language',
  'filter-defaults-default-word-count': 'search-word-count',
  'filter-defaults-default-completion-status': 'search-completion',
  'filter-defaults-default-crossovers': 'search-crossovers',
  'filter-defaults-word-count-menu': 'word-count-toolbar',
  'filter-defaults-completion-menu': 'completion-toolbar',
  'customize-search-results-rules': 'rules',
  'customize-search-results-exclude-hidden-works-from-the-search': 'auto-exclude-hidden',
  'customize-search-results-crossovers': 'hide-crossovers',
  'customize-search-results-collapse-or-hide': 'hide-reason',
  'customize-search-results-show-what-matched': 'hide-show-matched-values',
  'instant-search-views-search-your-marked-for-later-list': 'search-marked-for-later',
  'instant-search-views-reload-your-own-lists': 'search-profile-lists-refresh-hours',
  'instant-search-views-reload-listings': 'search-listings-refresh-hours',
  'instant-search-views-search-the-works-youve-read': 'search-read-works',
  'instant-search-views-search-an-uncommon-tags-works': 'search-tag-works',
  'instant-search-views-search-a-series-works': 'search-series-works',
  'instant-search-views-search-text-search-results': 'search-text-results',
  'instant-search-views-search-a-filtered-listings-works': 'search-filtered-listing',
  'instant-search-views-maximum-works-to-load': 'search-max-results',
  'instant-search-views-results-per-page': 'search-per-page',
  'review-tracked-lists': 'tracked-lists',
  'user-profile-lists-marked-for-later': 'marked-for-later',
  'user-profile-lists-read-works': 'read-works',
  'offline-reading-changes-made-in-an-export': 'export-changes',
  'offline-reading-cached-work-text': 'cached-work-text',
  'offline-reading-save-comments-with-cached-works': 'cache-comments',
  'offline-reading-discard-unneeded-blurbs-automatically': 'prune-orphaned-blurbs',
  'marks-status-work-marks': 'work-marks',
  'work-statistics-reading-speed': 'words-per-minute',
  'work-statistics-reading-time': 'show-total-time',
  'work-statistics-finish-reading-at': 'show-total-finish',
  'work-statistics-kudos-hits-ratio': 'show-kudos-hits-ratio',
  'chapter-statistics-word-count': 'show-chapter-words',
  'chapter-statistics-reading-time': 'show-chapter-time',
  'chapter-statistics-finish-reading-at': 'show-chapter-finish',
  'chapter-statistics-last-updated': 'show-chapter-date',
  'work-text-reader-mode': 'reader-mode',
  'work-text-narrow-the-work-text': 'style-width',
  'work-text-force-text-alignment': 'force-alignment',
  'work-text-text-replacement': 'text-replacements',
  'sync-sync-settings-across-devices': 'sync-settings',
  'backups-keep-daily-backups': 'backups-enabled',
  'backups-number-of-daily-backups-to-keep': 'backup-count',
  'backups-restore-a-backup': 'restore-backup',
  'your-data-import-export-your-settings': 'import-export',
  'your-data-learned-fandom-ids': 'learned-fandom-ids',
  'under-the-hood-compress-filter-urls': 'compress-search-urls',
  'under-the-hood-debug-mode': 'verbose',
  'under-the-hood-impersonate-user-requests': 'impersonate-user-requests',
}

/** The key `id` leads to: its own, or the one it is an alias of. */
export function anchorKey(id: string): string {
  return Object.hasOwn(ANCHOR_ALIASES, id) ? ANCHOR_ALIASES[id]! : id
}

/** Bookmarks by their keys, in order, a row bookmarked under more than one of its ids kept once. */
export function currentBookmarks(ids: readonly string[]): string[] {
  return [...new Set(ids.map(anchorKey))]
}
