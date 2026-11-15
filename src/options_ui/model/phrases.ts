/** A clause made the start of a sentence: its first letter capitalised. */
export function sentence(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1)
}

/** A control's tooltip: what it does, then, while it is off, why, the reason worded to follow a dash. */
export function withReason(label: string, reason: string | null | undefined): string {
  return reason ? `${label} — ${reason}` : label
}

/** Titles as a sentence names them: “A”, “A” and “B”, “A”, “B” and “C”. */
export function titlesInWords(titles: readonly string[]): string {
  const quoted = titles.map(title => `“${title}”`)
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}` : quoted.join('')
}
