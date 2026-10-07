/** A clause made the start of a sentence: its first letter capitalised. */
export function sentence(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1)
}

/** A control's tooltip: what it does, then, while it is off, why, the reason worded to follow a dash. */
export function withReason(label: string, reason: string | null | undefined): string {
  return reason ? `${label} — ${reason}` : label
}
