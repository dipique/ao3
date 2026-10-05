import css from './darkSkin.css?inline'

/**
 * The opt-in dark skin (the `darkSkin` option): AO3 itself, recoloured in the
 * extension's dark palette.
 *
 * It wins its ties with AO3's own stylesheets by coming after them, the way a
 * site skin chosen on AO3 does. CSS declared in the manifest can't promise that
 * -- the browser cascades it ahead of the page's own sheets -- so the skin goes
 * in as a `<style>` at the end of `<head>`, once `<head>` is complete: the moment
 * `<body>` appears.
 *
 * It also has to be there before the first paint, or every page load flashes
 * white. The options only arrive asynchronously, so the last answer they gave is
 * kept in the page's `localStorage` and applied from there at `document_start`;
 * reading the options then confirms it or takes it away.
 */

/** Marks the skin's `<style>`. Not `ADDON_CLASS`: a re-run's sweep would flash it off and on. */
const MARK = 'data-ao3e-dark-skin'

/** localStorage key. Namespaced so it doesn't collide with AO3's own storage. */
const LS_DARK_SKIN = 'ao3e:dark-skin'

let sheet: HTMLStyleElement | null = null
let waitingForBody: MutationObserver | null = null

function attach(style: HTMLStyleElement) {
  waitingForBody?.disconnect()
  waitingForBody = null
  ;(document.head ?? document.documentElement).append(style)
}

function show() {
  if (sheet)
    return
  const style = document.createElement('style')
  style.setAttribute(MARK, '')
  style.textContent = css
  sheet = style
  if (document.body) {
    attach(style)
    return
  }
  waitingForBody = new MutationObserver(() => {
    if (document.body)
      attach(style)
  })
  waitingForBody.observe(document, { childList: true, subtree: true })
}

function hide() {
  waitingForBody?.disconnect()
  waitingForBody = null
  sheet?.remove()
  sheet = null
}

// localStorage can refuse access outright (site data blocked), and this runs at
// the top of the content script, where a throw would stop everything after it.
function remembered(): boolean {
  try {
    return localStorage.getItem(LS_DARK_SKIN) === '1'
  }
  catch {
    return false
  }
}

function remember(on: boolean) {
  try {
    if (on)
      localStorage.setItem(LS_DARK_SKIN, '1')
    else
      localStorage.removeItem(LS_DARK_SKIN)
  }
  catch {}
}

/** At `document_start`: apply the skin if the last page had it on. */
export function applyRememberedDarkSkin(): void {
  if (remembered())
    show()
}

/** Once the options are read, and again whenever they change. */
export function applyDarkSkin(on: boolean): void {
  remember(on)
  if (on)
    show()
  else
    hide()
}
