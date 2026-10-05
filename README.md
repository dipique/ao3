# AO3 Enhancements

A browser extension for Firefox and Chrome that adds configurable tools to [Archive of Our Own](https://archiveofourown.org): instant search and filtering over lists AO3 can't sort, your own per-work marks, rules that hide or highlight works, tracked searches with a review of what's new, text replacement, a reader mode, settings sync with backups, offline exports, and a number of smaller tweaks.

It began as a fork of [jsmnbom/ao3-enhancements](https://github.com/jsmnbom/ao3-enhancements) and has grown well beyond it. It is **not published in any extension store**: to use it, [build it and load it yourself](#installation).

## Features

The options live behind the **AO3 Enhancements** menu the extension adds to AO3's header (the floating toolbar and your browser's extension settings open them too). Setting names below are in bold, as the options page labels them; its search box (press `/`) finds any of them.

Some features are on out of the box: the statistics, a narrower reading column, collapsing works that list more than seven fandoms, the instant search views and tracked lists. Everything else is off until you turn it on.

### Reading a work

- Work statistics: **Reading time** and **Finish reading at**, worked out from your **Reading speed**, plus a **Kudos/hits ratio**, wherever a work's stats line appears.
- Chapter statistics: **Word count**, **Reading time**, **Finish reading at** and **Last updated** on each chapter as you read.
- **Show statistics in columns** puts each statistic's label above its value instead of running them together.
- **Reader mode**: Ctrl+scroll or a pinch over the work text resizes and reflows it instead of zooming the page, and handles at its edges set the reading width. Remembered per device.
- **Narrow the work text** and **Force text alignment** for works that are hard to read as posted.
- **Text replacement**: find-and-replace rules for the displayed text of a work's summary, notes and chapters, with case, whole-word and across-formatting options. The work itself is untouched.
  - **Editing tools on the work page** underline replaced text (click it to edit the rule) and turn any text you select into a new rule.

### Browsing and searching

- Instant search views load a whole listing into one page, with a text search, sorting (by date, length, kudos, kudos %, hits, comments, bookmarks and more), and include/exclude filters for your marks, rating, warnings, category, fandom, relationship, character, additional tags, language, completion and word count. They're offered on:
  - your Marked for Later page, which **Search your Marked for Later list** replaces with one;
  - your History and Marked for Later pages, as a "Search read items" button (**Search the works you've read**; needs work marks);
  - uncommon tags, which AO3 lists but won't sort or filter (**Search an uncommon tag's works**);
  - series pages (**Search a series' works**);
  - works search results (**Search text-search results**).
- **Maximum works to load** caps how much a view fetches, and it asks before loading part of a bigger listing; **Results per page** sets the paging; lists are cached between visits (**Auto-reload frequency for profile search lists**).
- **Default language** and **Default word count** pre-fill AO3's Sort & Filter sidebar and search forms when you haven't picked a value.
- **Word count menu** and **Completion menu**: click a work's word count or chapter total to filter by length, or to complete or in-progress works.
- **Compress filter URLs** shortens the address a long set of filters produces, so it stays under AO3's length limit.

### Menus and page controls

- **Right-click menus** (long-press on touch) on tags, fandoms, authors and works let you act on them without leaving the page. Tags, fandoms and authors each have their own switch; works and series get a menu when rules, marks or **Mark a work for later** are on.
  - **Menu on tags**: include or exclude the tag in Sort & Filter, or hide, always-show or highlight it everywhere. It also covers the rating, warning, category and completion symbols on each work.
  - **Menu on fandoms**: the same for fandoms, filtered by tag id from a bundled list, so it works for any fandom rather than only those the sidebar lists.
  - **Hide or highlight an author**, **Subscribe to an author** and **Mute an author** (the last two need you logged in to AO3).
  - **Mark a work for later** adds "Mark for later" and "Mark as read" to a work's menu (needs you logged in).
- **Open menus with a left-click** makes a plain click open the menu instead of following the link; Shift+click still follows it.
- The browser's own right-click menu also gets entries to hide or always-show a tag, an author or one of an author's pseuds.
- A floating button in the corner of AO3 pages holds quick actions: open the options, switch the menus off, toggle reader mode or the text replacement tools, "Track this search", and, with **Reveal filtered works** on, a peek at the works your filters hid.
- **Collapsible dashboard sidebar** folds away the sidebar on your own user pages.
- **Extension theme** (follow AO3, light or dark) for the extension's own pages and menus, and **Hide "muted author" notices**.
- **Dark skin for AO3** recolours AO3 itself in the extension's dark palette, on top of any site skin you chose on AO3.

### Hiding and highlighting works

- **Rules**: one list for hiding, collapsing, always-showing or highlighting works by tag (any tag, or one type such as fandom or character), author, work or series, matched exactly, by substring or by regular expression. Rules can also be added straight from the menus above.
  - Each rule has a priority from 0 to 9: when several match a work, the highest wins, and always-show wins a tie. A "hide tag" rule takes just the tag itself out of tag lists and the sidebar. Rules can be disabled without deleting them, and highlight colours can be set per target.
- **Crossovers** hides works listing more than a set number of fandoms; **Languages** hides works that aren't in a language you read.
- **Collapse or hide** decides whether those works shrink to a line saying why, with a button to show them, or disappear entirely. Rules decide this for themselves.
- **Show what matched** names the tag, fandom or author behind a collapsed work, with a button to exclude it in the sidebar.
- **Exclude hidden works from the search** adds whatever hid a work to AO3's own Sort & Filter exclusions, so the next page of results isn't mostly hidden works. Nothing is submitted for you.

### Marks and progress

- **Work marks**: mark a work Read, or give it a verdict (Favorite, Good, Boring, Bad, Gross, Hot, Dark, Feelsy, Fluff, No, Abandoned), from its menu, and an icon shows the mark wherever the work is listed. Marks are kept by the extension, not on AO3; pressing AO3's own "Mark as Read" records one too.
- Any mark can hide its works from listings. Marks can be renamed, reordered and given other icons, and you can add your own.
- The Ongoing mark ("Mark as ongoing…") records the chapter you reached and an optional wait-until date; instant search views then show the work as Ready, Waiting or Caught up.

### Tracked lists

- **Tracked lists** gather the new and updated works from saved searches, filtered listings, uncommon tags and series into one review, under a "Tracked" item on your readings page.
- Add a list with "Track this search" on the floating toolbar, or from a stored list under Site export. A new list is titled for what it searches ("Character: Draco Malfoy"), and no two lists share a title. Retitle, pause or remove lists on the options page.
- To change what a list searches, use "Refine on AO3" on its options row: it opens the list's search, and once you have changed it (the Sort & Filter sidebar, the search form) the floating toolbar offers "Update". The list keeps its place in your review, and the update can be undone. A page that searches what a list does, filtered differently, offers the same through "Track or update…".
- A review covers a range of days, oldest first. Mark whatever deserves marking, then "Mark reviewed" moves on to the next range. Works you've already marked read or saved for later are left out.

### Sync and backups

- **Sync settings across devices** keeps your settings in the browser's own synced storage, so they follow you to other browsers signed in to the same account. It shows how much of the roughly 100 KB quota is in use. Cached lists and work text are never synced.
  - An incoming update that would delete a large part of your rules, marks, text replacements or tracked lists is held until you choose "Accept the update" or "Keep this browser's settings", and AO3 pages tell you when that happens. Browsers running different versions of the sync format pause rather than overwrite each other.
- **Keep daily backups** takes a local snapshot the first time you change a setting each day, keeping as many as **Number of daily backups to keep**. **Restore a backup** rolls back to one, backing up your current settings first.

### Your data and offline exports

- **Import & export your settings** saves every setting, rule and mark to a file (everything, options only, or cache only) or loads one back. A settings file from the original AO3 Enhancements can be imported too.
- **Learned fandom ids**: the fandom, character and relationship tag ids the extension picks up as you browse, which you can export or clear.
- Site export saves a stored list and the full text of its works as one self-contained HTML file that runs the same instant search view offline, on any device, with no extension installed.
  - Fetching runs one job at a time, waits out AO3's rate limits, and can be stopped and continued later.
  - Marks you make while reading an export can be saved from it and replayed here with **Changes made in an export**.
  - **Cached work text** and **Discard unneeded blurbs automatically** control what is kept on disk between exports.
  - Safari won't run scripts in a local file. `src/site/serve.py` is a standard-library Python server for opening a folder of exports over your network instead.

### The options page

- Settings search (`/` to focus, Escape to clear), a **Descriptions** switch that hides the explanatory text, **Collapse all** and **Expand all**, and a link anchor on every setting.
- **Debug mode** logs what the extension is doing to the browser's developer console, which helps when reporting a problem.

The aim is for the extension to be at least as accessible as AO3 itself. If it falls short somewhere, please [open an issue](https://github.com/dipique/ao3/issues); bug reports and feature requests go there too.

## Installation

This fork isn't in the Chrome Web Store or on Firefox Add-ons. The store listings called AO3 Enhancements install the [original extension](#credits), not this one. To use this one, build it from source and load it into your browser.

You need Node.js 24 and pnpm 10 (the versions CI uses). Then:

```sh
git clone https://github.com/dipique/ao3.git
cd ao3
pnpm install
```

After loading it, open AO3 and use the **AO3 Enhancements** menu in the site's header to reach the options.

### Chrome

Needs Chrome 120 or later.

```sh
pnpm run build:prod:chrome   # builds into dist/chrome
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `dist/chrome` folder.

After rebuilding, press the reload button on the extension's card. Don't rely on restarting Chrome: it can keep running the previous build's background script.

### Firefox

Needs Firefox 117 or later (128 on Android).

```sh
pnpm run build:prod:firefox  # builds into dist/firefox
```

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `dist/firefox/manifest.json`.

A temporary add-on is removed when Firefox closes, so load it again after each restart. Release versions of Firefox only install signed add-ons permanently, and there is no signed build of this fork.

This build uses the same Firefox add-on ID as the original extension, so the two can't be installed side by side. Use a separate Firefox profile if you want to keep the original.

For development, `pnpm run start:chrome` and `pnpm run start:firefox` launch a browser with the build already loaded; see [Developing](#developing).

## Privacy and permissions

- **Where it runs:** only on `archiveofourown.org` and its subdomains. That is its one content-script match and its only host permission.
- **What it sends:** requests go to AO3 and nowhere else. It loads the listing pages, works and chapter indexes its features need (search views, tracked lists, site export, chapter dates), looks up your subscription or Marked for Later state when a menu needs it, and performs the actions you choose from its menus. These requests carry your AO3 login, as your own browsing does. There is no analytics or telemetry.
- **Where your data lives:** settings, marks and cached lists are kept in the browser's local extension storage. If you turn sync on, settings travel through the browser's own sync service (your Firefox or Google account) and nowhere else. Backups stay on the device. Reader mode's text size, the dashboard sidebar's folded state, whether the dark skin is on (so the next page can apply it before it's drawn) and which tracked list a tab is refining are kept in AO3's page storage on that device.
- **Permissions:** `storage` for settings and cached lists; `unlimitedStorage` because cached lists and exported work text outgrow the default quota; `contextMenus` for the entries in the browser's right-click menu; `alarms` to schedule sync.

## Developing

You need Node.js 24 and pnpm 10, as above; the build scripts are TypeScript files that Node runs directly. The end-to-end tests and a few unit tests also need Google Chrome.

```sh
pnpm install
```

### Building

Builds go to `dist/<browser>/` (`dist/chrome` or `dist/firefox`). The builder starts from `src/manifest.ts`, which generates each browser's manifest in code, and bundles everything the manifest references: scripts with esbuild, the options page with Vite. Development builds are unminified; production builds are minified, with source maps beside them.

| | Chrome | Firefox |
| --- | --- | --- |
| Development build | `pnpm run build:dev:chrome` | `pnpm run build:dev:firefox` |
| Production build | `pnpm run build:prod:chrome` | `pnpm run build:prod:firefox` |
| Watch and rebuild | `pnpm run serve:dev:chrome` | `pnpm run serve:dev:firefox` |
| Launch a browser with the build | `pnpm run start:chrome` | `pnpm run start:firefox` |

`pnpm run build` makes production builds for both browsers. `build:dev`, `build:prod`, `serve:dev` and `serve:prod` with no browser suffix are Chrome, and `serve:prod:chrome` / `serve:prod:firefox` watch a production build.

Every build script wraps one command, which you can also run directly with the browser and mode in environment variables. They default to `chrome` and `development`; use `serve` in place of `build` to watch.

```sh
BROWSER=firefox NODE_ENV=production node scripts/builder/build.ts build
```

```powershell
$env:BROWSER="firefox"; $env:NODE_ENV="production"; node scripts/builder/build.ts build
```

The `start:*` scripts run [web-ext](https://github.com/mozilla/web-ext) against an existing build, so build (or `serve`) first. web-ext reloads the extension when the build changes; press R in its terminal if it doesn't. Their settings are in `scripts/web-ext.chrome.mjs` and `scripts/web-ext.firefox.mjs`. The Firefox one launches Firefox Developer Edition (`firefox-developer-edition`) with a profile named `development`, so adjust those to match your setup. `pnpm run start:firefox-android` targets Firefox for Android the same way.

Two things to know about the output:

- **Reload after rebuilding.** Outside web-ext, reload the extension yourself after a rebuild. In Chrome use the reload button on `chrome://extensions`: Chrome can keep serving an unpacked extension's old background script across rebuilds and even restarts.
- **`dist/` is never emptied.** A file a build stops emitting stays in `dist/<browser>/` and gets packaged. Delete `dist/` when output names change. `pnpm run clean` still points at an old `build/` directory and doesn't touch `dist/`.

`src/data/fandom-index.json`, the bundled fandom-to-tag-id lookup, is generated by `pnpm run gen:fandom-index` from a fandom id cross-reference that is maintained by tooling outside this repository. Don't edit it by hand.

### Type checking

```sh
pnpm run typecheck         # vue-tsc -b, incremental
pnpm run typecheck:force   # rebuild everything
```

esbuild and Vite strip types without checking them, so this is the only type check. It is `vue-tsc` rather than `tsc` because plain `tsc` can't resolve the options page's `.vue` files.

### Tests

Tests use Node's built-in test runner; there's no test framework to install.

```sh
pnpm run tests:unit   # everything in test/ except test/e2e/; no build needed
pnpm run tests:e2e    # test/e2e/; builds dist/chrome and drives it in headless Chrome
pnpm run tests        # both (alias for tests:all)
pnpm run verify       # typecheck, lint, then all tests: run this before sending a change
```

- **Unit tests** import modules straight from `src/`. Node strips TypeScript types instead of compiling them, so only pure modules (no `#common` import, no `browser` APIs) can be tested this way, and syntax that would emit code (`enum`, namespaces with a body, parameter properties) is rejected; `erasableSyntaxOnly` in the tsconfig enforces this. A few site-export tests load one module into headless Chrome for a DOM, and skip when Chrome isn't found.
- **End-to-end tests** build a production `dist/chrome` if it's missing or older than its sources, then drive the built options page and content scripts in headless Chrome through `puppeteer-core`. The files run in parallel, and the build is taken under a lock so they don't build over each other.

Chrome is found in its usual install locations on Windows, macOS and Linux. Set `CHROME_PATH` to a Chrome or Chromium binary if it's somewhere else.

To run one file, or a few:

```sh
node --test test/searchView/engine.test.mjs
node --test "test/siteExport/*.test.mjs"
```

Quote globs, so that Node expands them rather than your shell. Pass a glob rather than a directory: `node --test` on a directory fails on Windows.

CI (`.github/workflows/ci.yml`) runs the typecheck, lint and unit tests on every push and pull request. The end-to-end tests are run locally only.

### Linting

```sh
pnpm run lint       # checks the generated auto-import type stubs, then runs eslint .
pnpm run lint:fix   # eslint . --fix
```

ESLint uses `@antfu/eslint-config`, with stylistic rules, UnoCSS class ordering and sorted imports. To fix only the files you changed, run `pnpm exec eslint --fix <files>`; a repository-wide fix can restyle files you didn't mean to touch.

### Packaging

```sh
pnpm run build      # production builds for both browsers
pnpm run dist       # zips them with web-ext, plus a source archive
pnpm run dist:lint  # runs web-ext lint on the Firefox build
```

`pnpm run dist` writes `ao3-enhancements_chrome_<version>.zip` and `ao3-enhancements_firefox_<version>.zip` under `dist/artifacts/<browser>/`, taking the version from `package.json` and leaving source maps out, plus `dist/artifacts/source/ao3-enhancements_source_<version>.zip`, a `git archive` of `HEAD`. It runs on Windows as well as Linux; the release workflow runs it on Linux.

### Project layout

- `src/manifest.ts`: the manifest, generated per browser. Permissions, content-script matches and minimum browser versions are set here.
- `src/background/`: the service worker (Chrome) or background script (Firefox): message routing, storage migrations, the browser's context-menu entries, sync and backups.
- `src/content_script/`: runs on AO3 pages. Each feature is a `Unit` subclass in `src/content_script/units/`, registered in order in `units/index.ts`. The instant search views are in `searchView/`.
- `src/options_ui/`: the options page, in Vue 3 with reka-ui and UnoCSS.
- `src/site/`: the app inside a site export, which reuses the content script's search view.
- `src/common/`: shared code, mostly pure so it can be unit-tested.
- `test/`: unit tests by area, and `test/e2e/` for the end-to-end tests.

The content scripts' `.tsx` files use a small JSX factory (`#dom`) that builds real DOM nodes immediately. It is not React: there's no virtual DOM and there are no hooks. The options page is ordinary Vue.

To add a setting, add it to the `Options` interface in `src/common/options.ts` and its default to `OPTION_DEFAULTS` in `src/common/optionDefaults.ts`. If it syncs, bump `SYNC_SCHEMA_VERSION` in `src/common/syncCodec.ts`; `test/sync/compat.test.mjs` fails until you do.

## Releasing

Releases are driven by git tags. The workflow was inherited from the original extension, and its store steps still assume that extension's accounts.

1. `pnpm version <version>` sets the version in `package.json` and creates a matching `v<version>` tag. The only pre-release form the build accepts is `-beta.N`: `1.2.0-beta.1` becomes manifest version `1.2.0.1`, so the stable release after a beta needs a higher version number than the beta's base (`1.2.1`, not `1.2.0`).
2. `git push && git push --tags`. A pushed `v*` tag runs `.github/workflows/build-extension.yml`, which:
   - runs the CI checks (typecheck, lint, unit tests);
   - runs `pnpm run build`, `pnpm run dist` and `pnpm run dist:lint`;
   - signs the Firefox build and submits it to addons.mozilla.org with `web-ext sign` (listed, or unlisted for a beta), using the `AMO_API_KEY` and `AMO_API_SECRET` secrets;
   - uploads the Chrome zip to the Chrome Web Store (not for betas), using the `CHROME_*` secrets;
   - creates a draft GitHub release with the source, Chrome and Firefox packages, but only if the Firefox job succeeded.

The workflow can also be started by hand with a version and a store, to submit an existing tag to that one store.

This fork isn't listed in either store, and its manifest still carries the original's Firefox add-on ID (`ao3-enhancements@jsmnbom`), which addons.mozilla.org ties to the original's listing. Without store secrets the Firefox job fails, and the draft GitHub release, which waits on it, isn't created. `pnpm run build` and `pnpm run dist` produce the same packages locally.

## Credits

This is a fork of [AO3 Enhancements](https://github.com/jsmnbom/ao3-enhancements) by Jasmin Bom ([@jsmnbom](https://github.com/jsmnbom)), and much of it is still the original's code. The original extension is published on [Firefox Add-ons][amo] and the [Chrome Web Store][cws]. Those listings install the original, not this fork.

Thanks to:

- the icon's sources: the AO3 logo (SVG version from IconFinder), combined with the Gear icon from GitHub's Octicons pack;
- [Hero Patterns](http://www.heropatterns.com/), for the options page background (CC BY 4.0);
- the userscripts that inspired the original extension:
  - [AO3: Kudos/hits ratio](https://greasyfork.org/en/scripts/3144-ao3-kudos-hits-ratio) by `Min`
  - [AO3: Estimated reading time](https://greasyfork.org/en/scripts/391940-ao3-estimated-reading-time) by `oulfis`
  - [ao3 crossover savior](https://greasyfork.org/en/scripts/13274-ao3-crossover-savior) by `tegan`

## License

MIT, as the original is. See [LICENSE](LICENSE), which carries the original extension's copyright notice.

[amo]: https://addons.mozilla.org/en-US/firefox/addon/ao3-enhancements/ 'The original AO3 Enhancements on Firefox Add-ons'
[cws]: https://chrome.google.com/webstore/detail/ao3-enhancements/eljennickgdbghppcaenkcinjafmnfoi 'The original AO3 Enhancements on the Chrome Web Store'
