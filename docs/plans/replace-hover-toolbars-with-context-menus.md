# Plan: Replace hover toolbars with right-click / long-press context menus + permanent indicators

## Context

All of the extension's per-blurb actions are gated behind **hover**: the tag/fandom
include-exclude toolbars (`TagToolbar`, `FandomToolbar`) only appear on `:hover`, and the
work/series filter, hide-author, subscribe, mute and mark-for-later controls are faint
icons that only become usable when you mouse over them. None of this works on a phone or
tablet (no hover), so those features are effectively desktop-only.

This change moves every hover-gated action onto a **custom in-page context menu** opened by
right-click (desktop) or long-press (touch), and shows a **permanent indicator icon** next
to an item only when a state is active. The indicators are themselves trigger points (left
click / right click / short tap / long-press all open the menu). It also folds the
single-purpose author/work toggle buttons into their entity's menu, adds hide/invert/
highlight options to the tag **and** fandom menus, and gives the "hidden item" explanation
text a tap-to-open popover.

### Decisions locked with the user
- **No hover affordance.** Inactive items expose the menu only via right-click/long-press; only active states show an indicator.
- **Fold one-tap actions in.** Mark-for-later → work menu; subscribe/mute/hide → author menu. Indicators shown only when active.
- **Suppress the native menu on our decorated links**, with two mitigations: (a) a toggle on the floating toolbar that disables all our context menus (restoring native menus), and (b) every menu (when we override native) ends with **Copy text / Copy address / Open in new tab**.
- **Fandoms get hide/invert/highlight too**, in addition to include/exclude.

## Key existing pieces to reuse
- Filter-sidebar (ephemeral include/exclude) API: `toggleTagFilter`/`isTagSelected`/`hasTagFilterFields`, `toggleFandomFilter`/`isFandomSelected`/`resolveFandomId*`, `toggleCheckboxGroupFilter` in [filterSidebar.tsx](ao3/extension/src/content_script/filterSidebar.tsx), plus `onFilterChange`/`notifyFilterChange` for cross-instance re-sync.
- Persistent-filter toggling pattern (read freshest options → find exact filter → toggle → `options.set`): already in [FilterEntityToolbars.tsx:155](ao3/extension/src/content_script/units/FilterEntityToolbars.tsx#L155) (`onClick`), [HideAuthorToolbar.tsx:106](ao3/extension/src/content_script/units/HideAuthorToolbar.tsx#L106), and [background/menus.ts:79](ao3/extension/src/background/menus.ts#L79).
- Match predicates `tagFilterMatchesTag`, `entityFilterMatches`, `authorFilterMatchesAuthor` from `#common`.
- Blurb/tag parsing for tag **type** (needed for persistent tag/fandom filters): `getBlurb`/`BlurbTag` in [blurb.ts](ao3/extension/src/content_script/blurb.ts), `getTag` in [utils.tsx](ao3/extension/src/content_script/utils.tsx).
- Network helpers to fold in: `submitMark` ([MarkForLaterToolbar.tsx:49](ao3/extension/src/content_script/units/MarkForLaterToolbar.tsx#L49)), `parseSubscription`/`submitSubscription` ([SubscribeAuthorToolbar.tsx](ao3/extension/src/content_script/units/SubscribeAuthorToolbar.tsx)), `parseMuteState`/`submitMuteForm` ([MuteAuthorToolbar.tsx](ao3/extension/src/content_script/units/MuteAuthorToolbar.tsx)), `getAuthorPage` ([authorPage.ts](ao3/extension/src/content_script/authorPage.ts)).
- JSX factory `#dom`, `ADDON_CLASS`, `toast`, and the `Unit` lifecycle (`clean()` removes all `.AO3E` nodes; units rebuild registries each `ready()`).

## New shared modules (under `src/content_script/`)

### `contextMenu.tsx` — the floating menu + popover layer
- `interface MenuItem { icon?, label, active?, danger?, disabled?, separatorBefore?, onSelect?, resolve? }`.
- `openMenu(items: MenuItem[], at: {x, y})`: builds `<div class="AO3E--menu">`, renders each item (icon + label, check/accent when `active`, red when `danger`, separators), positions at the point clamped to the viewport, appends to `document.body`. Single instance at a time; dismiss on outside `pointerdown`, `Escape`, `scroll`, `resize`. Running `onSelect` closes the menu.
- `resolve?` support: after render, any item with `resolve()` is awaited and its row patched in place (used for subscribe/mute whose state needs a network fetch — show "Checking…/disabled" then update to Subscribe/Unsubscribe).
- `openPopover(content, at)`: same layer/dismiss logic, renders an info box (`AO3E--popover`) for the hidden-item explanation. `closeFloating()` shared.

### `contextTrigger.ts` — attach triggers + global enable flag + standard link items
- Module flag `menusEnabled` with `setMenusEnabled`/`getMenusEnabled`; seeded from the new `contextMenusEnabled` option on each `run()`.
- `attachMenuTrigger(el, build: () => MenuItem[] | Promise<MenuItem[]>, opts?: { indicator?: boolean })`:
  - `contextmenu` → if `!menusEnabled` return (native menu shows); else `preventDefault()` and open at pointer. Primary path for desktop right-click and most mobile long-press.
  - Touch long-press fallback via pointer events (`pointerdown` with `pointerType !== 'mouse'`, ~450 ms timer, cancel on move > ~10 px / `pointerup` / `pointercancel` / scroll), deduped against `contextmenu` so only one menu opens; suppress the click that follows so the link doesn't navigate.
  - `indicator: true` also opens on plain left `click`/short tap, and works even when `menusEnabled` is false (indicators are ours, not links).
- `standardLinkItems(link)`: `Copy text`, `Copy address` (`navigator.clipboard.writeText`), `Open in new tab` (`window.open(href, '_blank')`). Appended by link-based menus only while `menusEnabled` (i.e. when we're actually overriding native).

### `persistentFilters.ts` — toggle/read the persistent extension filters
Centralizes the read-freshest → find-exact → toggle-behavior → `options.set` pattern for `hideTags`/`hideAuthors`/`hideWorks`/`hideSeries`:
- `toggleTagBehavior(tag: {name, type?}, behavior)`, `toggleEntityBehavior(optionKey, value, behavior)`, `toggleAuthorBehavior(userId, behavior, pseud?)` — setting a behavior that's already present clears it (menu toggle semantics).
- Sync state readers used to build indicators/active flags from `this.options` (e.g. `tagBehaviorState(filters, tag) → {hide, invert, highlight}`).

### Indicator helper (in `contextTrigger.ts` or a small `indicators.tsx`)
`buildIndicators(states)` → `<span class="AO3E--indicators">` containing one small icon per active state (green include/invert, red exclude/hide, highlight-colored star, blue bell, amber mute). Returns `null`/empty when nothing is active. The span gets `attachMenuTrigger(..., {indicator:true})` to reopen the entity's menu.

## Per-feature changes (rewrite existing units in place)

| Element (selector) | Menu items | Indicators |
|---|---|---|
| **Tag** `.blurb ul.tags a.tag` ([TagToolbar.tsx](ao3/extension/src/content_script/units/TagToolbar.tsx)) | Include / Exclude (sidebar, only if `hasTagFilterFields()`) · Hide / Always-show / Highlight (persistent `hideTags`, with tag **type** from blurb parse) · standard link items | include/exclude/hide/invert/highlight when active |
| **Fandom** `h5.fandoms a.tag` ([FandomToolbar.tsx](ao3/extension/src/content_script/units/FandomToolbar.tsx)) | Include / Exclude (id-based sidebar; resolve id when menu opens) · Hide / Always-show / Highlight (persistent `hideTags` as `TagType.Fandom`, by name — no id needed) · standard link items | same set |
| **Work** `.blurb .header h4.heading a[href*="/works/"]` ([FilterEntityToolbars.tsx](ao3/extension/src/content_script/units/FilterEntityToolbars.tsx)) | Hide / Highlight / Always-show (set directly, not cycle) · **Mark for later / Mark as read** (folds in `submitMark`) · standard link items | filter-state icon + saved-clock |
| **Series** `a[href*="/series/"]` (same file) | Hide / Highlight / Always-show · standard link items | filter-state icon |
| **Author** `a[rel=author]` ([HideAuthorToolbar.tsx](ao3/extension/src/content_script/units/HideAuthorToolbar.tsx) becomes the single author menu) | Hide author / Always-show / Highlight · Hide this pseud (on pseud links) · **Subscribe/Unsubscribe** (`resolve` async) · **Mute/Unmute** (`resolve` async) · standard link items | hidden / highlight only (subscribe/mute state needs a fetch, so menu-only) |
| **Hidden-item explanation** `.AO3E--hide-works--reason-value` ([HideWorks.tsx:363](ao3/extension/src/content_script/units/HideWorks.tsx#L363)) | n/a — tap/click (and long-press) opens `openPopover` with the same rule text already in the `title` attr (kept for desktop hover) | — |

- **Folding:** convert `SubscribeAuthorToolbar.tsx` and `MuteAuthorToolbar.tsx` into helper modules (`authorActions.ts`) exporting their parse/submit functions; the author menu calls them. `MarkForLaterToolbar.tsx`'s `submitMark` likewise reused by the work menu. Remove `SubscribeAuthorToolbar`, `MuteAuthorToolbar`, `MarkForLaterToolbar` (and the now-merged work/series toggle classes if split) from [units/index.ts](ao3/extension/src/content_script/units/index.ts).
- **Option keys keep their names/semantics** (which feature is on): `tagToolbar`, `fandomToolbar` gate their menus; `markForLaterToolbar` gates the work-menu mark item; `hideAuthorToolbar`/`subscribeAuthorToolbar`/`muteAuthorToolbar` gate the matching author-menu items (the author menu unit is "enabled" if any is on). hide/invert/highlight items are always offered (they need no sidebar).

## Global "disable context menus" toggle
- Add option `contextMenusEnabled: boolean` (default `true`) to [options.ts](ao3/extension/src/common/options.ts) (interface + defaults). `content_script.ts` seeds `setMenusEnabled(opts.contextMenusEnabled)` in `run()`.
- [FilterToolbar.tsx](ao3/extension/src/content_script/units/FilterToolbar.tsx) gains a second pill button (icon toggle) that flips `contextMenusEnabled` (persist + `setMenusEnabled` immediately). To keep this escape-hatch reachable, render the pill whenever any menu decorator is active on the page (not only when works are hidden); keep the **peek** button conditional on `count > 0` as today.

## CSS ([content_script.css](ao3/extension/src/content_script/content_script.css))
- Add `.AO3E--menu` / `--item` / `--active` / `--danger` / `--separator`, `.AO3E--popover`, `.AO3E--indicators` (+ per-state color rules reusing existing greens/reds/blue/amber and `--ao3e-highlight-color`), and the floating-pill second button.
- Remove the now-dead hover rules: `.AO3E--tag-toolbar` `:hover` display block, `.AO3E--fandom-toolbar--visible`, and the `opacity .4→1 on :hover` blocks for hide-author/subscribe/mute/mark-for-later/work/series toggles.

## Options UI copy (labels only; keep option ids)
Update "toolbar" wording to "menu" in [Search.vue](ao3/extension/src/options_ui/categories/Search.vue) (tag/fandom/mark-for-later/filter-peek) and [HideWorks.vue](ao3/extension/src/options_ui/categories/HideWorks.vue) (hide/subscribe/mute author), noting the new right-click/long-press behavior and the disable toggle.

## Out of scope / left as-is
- Background [menus.ts](ao3/extension/src/background/menus.ts) native context-menu integration stays (complementary, and the only menu shown when the user disables ours).
- The in-memory search-view sidebar toggles (not hover-gated).

## Verification
1. `cd ao3/extension && pnpm install && pnpm build` (and `pnpm lint`/`pnpm typecheck` if present) — confirm a clean build for both Firefox and Chrome targets.
2. Load the unpacked build; on an AO3 **works listing** (a tag's `/works` page, which has the filter sidebar):
   - Right-click a tag → menu with include/exclude (toggling reflects in the sidebar + indicator) and hide/highlight/always-show (persists; reload shows indicator). Repeat for a fandom.
   - Right-click a work title → hide/highlight/always-show + mark-for-later; confirm indicators and that mark-for-later hits the network (toast).
   - Right-click an author byline → hide/highlight, subscribe, mute; confirm subscribe/mute rows resolve then act.
   - Click a permanent indicator (left click) → same menu opens.
   - On a hidden blurb, tap the explanation value → popover with the rule text.
3. **Touch:** with devtools device emulation (or a real device), long-press each of the above opens the menu; verify the link doesn't navigate and text isn't selected.
4. **Disable toggle:** flip the floating-toolbar toggle → right-clicking a link now shows the browser's native menu; indicators still open menus on left click. Flip back.
5. Confirm `Copy text` / `Copy address` / `Open in new tab` appear and work while menus are enabled.
