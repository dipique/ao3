/** How serious a message is, most serious first. Its colour marks the message's glyph, edge and tint. */
export const SEVERITIES = ['destructive', 'warning', 'success', 'neutral'] as const

export type Severity = typeof SEVERITIES[number]
