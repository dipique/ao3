const DATE_AND_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }
const TIME: Intl.DateTimeFormatOptions = { timeStyle: 'short' }

/**
 * A moment as the options page writes one: a medium date and a short time, in
 * the reader's locale. Given `now`, a moment on the same calendar day reads
 * "Today" and one on the day before "Yesterday", in place of the date.
 */
export function formatMoment(at: number, now?: number): string {
  if (now !== undefined) {
    const day = startOfDay(at)
    const today = startOfDay(now)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    if (day === today)
      return `Today, ${new Date(at).toLocaleTimeString(undefined, TIME)}`
    if (day === yesterday.getTime())
      return `Yesterday, ${new Date(at).toLocaleTimeString(undefined, TIME)}`
  }
  return new Date(at).toLocaleString(undefined, DATE_AND_TIME)
}

function startOfDay(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** Largest unit first would read "0 years ago"; smallest first stops at the right one. */
const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.345],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

/** How long before `now` a moment was, in the reader's locale: "22 minutes ago", "yesterday"; "never" for none (0). */
export function timeAgo(at: number, now: number): string {
  if (!at)
    return 'never'
  let value = (at - now) / 1000
  for (const [unit, span] of RELATIVE_STEPS) {
    if (Math.abs(value) < span)
      return RELATIVE.format(Math.round(value), unit)
    value /= span
  }
  return RELATIVE.format(Math.round(value), 'year')
}
