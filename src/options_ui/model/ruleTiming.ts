import type { RuleTimingSummary } from '../../common/ruleTiming.ts'

/**
 * What the foot of the options page says of how long the rules take to weigh:
 * a summary line, and the split between matching and changing the page under it.
 */
export interface RuleTimingText {
  summary: string
  detail: string | null
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`
}

const ms = (value: number) => `${value.toFixed(2)}ms/100 items`

export function ruleTimingText(summary: RuleTimingSummary | null): RuleTimingText {
  if (!summary)
    return { summary: 'No ruleset evaluations recorded yet.', detail: null }

  const window = summary.withinWindow ? ' in the last seven days' : ''
  const { exact, contains, regex } = summary.averageMatchers
  const page = summary.pageMsPer100 === null ? '' : ` Changing AO3 listing pages: ${ms(summary.pageMsPer100)}.`
  return {
    summary: `${plural(summary.evaluations, 'ruleset evaluation')}${window} on ${plural(summary.works, 'total work')}. `
      + `Average time to process ruleset: ${ms(summary.msPer100)} for ${summary.averageRules.toFixed(1)} average rules.`,
    detail: `Matching rules: ${ms(summary.matchMsPer100)}.${page} `
      + `Rules by match type, on average: ${exact.toFixed(1)} exact, ${contains.toFixed(1)} contains, ${regex.toFixed(1)} regex.`,
  }
}
