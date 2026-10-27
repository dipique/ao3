/**
 * Reading what a page or a model says for the facts it carries, rather than
 * for how it words them, so rewording it fails no test.
 */

/**
 * Whether `text` carries `fact` — a reason or name the page words, imported
 * from where the page gets it, or a name or number from the test's own data —
 * wherever the sentence puts it, and however it is capitalised there.
 */
export function mentions(text, fact) {
  return text.toLowerCase().includes(String(fact).toLowerCase())
}

/**
 * The numbers `text` gives, in the order it gives them, a decimal whole: for
 * figures whose order says which is which, as "68.0 KB of 100.0 KB · 68%".
 */
export function numbers(text) {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/**
 * The numbers `text` gives, smallest first, once each of `parts` — figures
 * worded elsewhere, such as an age or a size — has been taken out of it. Each
 * part must be there. A number grouped by thousands is one number, and one
 * inside a word, as AO3's, is none.
 */
export function figures(text, ...parts) {
  let rest = text
  for (const part of parts) {
    if (!mentions(rest, part))
      throw new Error(`${JSON.stringify(text)} doesn't give ${JSON.stringify(part)}`)
    const at = rest.toLowerCase().indexOf(String(part).toLowerCase())
    rest = `${rest.slice(0, at)} ${rest.slice(at + String(part).length)}`
  }
  return (rest.match(/\b\d(?:,?\d)*\b/g) ?? []).map(n => Number(n.replace(/,/g, ''))).sort((a, b) => a - b)
}
