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
