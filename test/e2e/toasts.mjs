/**
 * The toasts on screen, read out of the shadow roots they are drawn in. The
 * options page and the AO3 pages draw them alike, so a test of either reads
 * them here.
 */

/** The type of each toast on screen — `success`, `error`, or null for a plain one. */
export function toastTypes(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast') ?? []])
    .map(el => el.dataset.type ?? null))
}

/** Which toast each one on screen is, by its `data-ao3e-toast`; null for one with no name. */
export function toastNames(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast') ?? []])
    .map(el => el.dataset.ao3eToast ?? null))
}

/** Where the links the toasts on screen offer go, as the page resolves each `href`. */
export function toastLinks(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast a.link') ?? []])
    .map(a => a.href))
}

/** Follow the toast's link to `href`, as a click on it does. */
export function clickToastLink(tab, href) {
  return tab.evaluate((to) => {
    for (const el of document.querySelectorAll('body > div')) {
      const link = [...el.shadowRoot?.querySelectorAll('.toast a.link') ?? []].find(a => a.href === to)
      if (link) {
        link.click()
        return true
      }
    }
    return false
  }, href)
}

/**
 * The toasts on screen, as `{ name, type, message }`: `name` is the toast's
 * `data-ao3e-toast`, which says which one it is however it is worded.
 */
export function shownToasts(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast') ?? []])
    .map(el => ({ name: el.dataset.ao3eToast ?? null, type: el.dataset.type ?? null, message: el.querySelector('.message')?.textContent.trim() ?? '' })))
}

/** The toast named `name` that is on screen, as {@link shownToasts} gives it, or null. */
export async function toastNamed(tab, name) {
  return (await shownToasts(tab)).find(one => one.name === name) ?? null
}

/** Click the action of the toast named `name` (its **Undo**, its **Mark reviewed**). False when no such toast is up. */
export function pressToast(tab, name) {
  return tab.evaluate((want) => {
    for (const el of document.querySelectorAll('body > div')) {
      const button = el.shadowRoot?.querySelector(`.toast[data-ao3e-toast="${want}"] button.action`)
      if (button) {
        button.click()
        return true
      }
    }
    return false
  }, name)
}
