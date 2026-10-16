import type { Rule } from './data.ts'

import { RULE_TIMING_MIN_KEPT, RULE_TIMING_WINDOW_MS } from './constants.ts'

type Matcher = Rule['matcher']

/**
 * One time the reader's rules were weighed against a set of works, and how long
 * it took — kept so the options page can say whether the rules have grown too
 * many or too costly to match.
 *
 * `where` says which pass it was. `'page'` is an AO3 listing, where each work is
 * weighed and then hidden or collapsed in turn, so the time splits into
 * {@link RuleTiming.matchMs} and {@link RuleTiming.pageMs}. `'list'` is a search
 * view's (or the tracked review's) whole set, weighed up front with nothing
 * drawn yet, so all of its time is matching.
 */
export interface RuleTiming {
  /** When it ran, epoch milliseconds. */
  at: number
  where: 'page' | 'list'
  works: number
  /** How many rules able to hide or show a work were weighed. */
  rules: number
  /** {@link RuleTiming.rules}, by how each one matches. */
  matchers: Record<Matcher, number>
  /** The whole pass, in milliseconds. */
  ms: number
  /** Of {@link RuleTiming.ms}, the time spent deciding what the rules say of each work. */
  matchMs: number
  /** Of {@link RuleTiming.ms}, the time spent hiding and collapsing works; `'page'` passes only. */
  pageMs?: number
}

export interface RuleTimingSample {
  at: number
  where: RuleTiming['where']
  works: number
  rules: ReadonlyArray<Pick<Rule, 'matcher'>>
  ms: number
  matchMs: number
  pageMs?: number
}

/**
 * The record of one pass, or null for a pass not worth recording: with no rules
 * nothing of the ruleset was weighed, and with no works there is no rate to
 * speak of.
 */
export function ruleTimingEntry(sample: RuleTimingSample): RuleTiming | null {
  const { rules, pageMs, ...rest } = sample
  if (rules.length === 0 || sample.works === 0)
    return null
  const matchers: Record<Matcher, number> = { exact: 0, contains: 0, regex: 0 }
  for (const { matcher } of rules)
    matchers[matcher]++
  return { ...rest, rules: rules.length, matchers, ...(pageMs === undefined ? {} : { pageMs }) }
}

/**
 * The evaluations worth keeping at `now`: every one inside
 * {@link RULE_TIMING_WINDOW_MS}, and the newest {@link RULE_TIMING_MIN_KEPT}
 * whatever their age — whichever is more. The list is oldest first, as it is
 * appended to.
 */
export function keepRuleTimings(log: RuleTiming[], now: number): RuleTiming[] {
  const since = now - RULE_TIMING_WINDOW_MS
  const firstKept = log.findIndex((entry, index) => entry.at >= since || index >= log.length - RULE_TIMING_MIN_KEPT)
  if (firstKept === -1)
    return []
  return firstKept === 0 ? log : log.slice(firstKept)
}

/** The stored list with `entry` added, pruned as of when it ran. */
export function appendRuleTiming(log: RuleTiming[] | undefined, entry: RuleTiming): RuleTiming[] {
  return keepRuleTimings([...(Array.isArray(log) ? log : []), entry], entry.at)
}

export interface RuleTimingSummary {
  evaluations: number
  works: number
  /** Whether every evaluation counted ran inside {@link RULE_TIMING_WINDOW_MS}. */
  withinWindow: boolean
  /** Milliseconds per 100 works, weighted by works. */
  msPer100: number
  matchMsPer100: number
  /** Over `'page'` passes only; null when there were none. */
  pageMsPer100: number | null
  /** How many works the `'page'` passes covered. */
  pageWorks: number
  /** Rules per evaluation. */
  averageRules: number
  averageMatchers: Record<Matcher, number>
}

/** What the kept evaluations add up to at `now`; null when none are kept. */
export function summarizeRuleTimings(log: RuleTiming[], now: number): RuleTimingSummary | null {
  const kept = keepRuleTimings(log, now)
  if (kept.length === 0)
    return null

  let works = 0
  let ms = 0
  let matchMs = 0
  let pageWorks = 0
  let pageMs = 0
  let rules = 0
  const matchers: Record<Matcher, number> = { exact: 0, contains: 0, regex: 0 }
  for (const entry of kept) {
    works += entry.works
    ms += entry.ms
    matchMs += entry.matchMs
    if (entry.pageMs !== undefined) {
      pageWorks += entry.works
      pageMs += entry.pageMs
    }
    rules += entry.rules
    for (const matcher of Object.keys(matchers) as Matcher[])
      matchers[matcher] += entry.matchers[matcher] ?? 0
  }

  const per100 = (total: number, over: number) => total / over * 100
  const count = kept.length
  return {
    evaluations: count,
    works,
    withinWindow: kept[0]!.at >= now - RULE_TIMING_WINDOW_MS,
    msPer100: per100(ms, works),
    matchMsPer100: per100(matchMs, works),
    pageMsPer100: pageWorks > 0 ? per100(pageMs, pageWorks) : null,
    pageWorks,
    averageRules: rules / count,
    averageMatchers: {
      exact: matchers.exact / count,
      contains: matchers.contains / count,
      regex: matchers.regex / count,
    },
  }
}
