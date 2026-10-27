/** How serious a message is, most serious first. Its colour marks the message's glyph, edge and tint. */
export const SEVERITIES = ['destructive', 'warning', 'success', 'neutral'] as const

export type Severity = typeof SEVERITIES[number]

/** What a screen reader hears for each severity's glyph, before the words beside it. */
export const SEVERITY_WORDS = {
  destructive: 'Error:',
  warning: 'Warning:',
  success: 'Success:',
  neutral: 'Note:',
} as const satisfies Record<Severity, string>
