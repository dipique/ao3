import type { FilterBehavior, HighlightPreset, Rule, RuleColors, RuleTarget } from '../../common/data.ts'

import { DEFAULT_BEHAVIOR_PRIORITY, HIGHLIGHT_PRESETS, isTagTarget, ruleAffectsWorks, rulePriority, ruleTargetColor, ruleTargetLabel, ruleValueMatches, TagType } from '../../common/data.ts'

/**
 * The rule editor's choices and what saving them writes. The editor holds a
 * {@link RuleDraft}; the functions here take one and return the next, and
 * {@link draftRule} turns it into the rule to store.
 */

/**
 * What a rule does while it is on: every behaviour but `none`, which is what
 * the editor's Rule Enabled switch writes when it is off.
 */
export type RuleAction = Exclude<FilterBehavior, 'none'>

export const RULE_ACTIONS: readonly { value: RuleAction, label: string, help: string }[] = [
  { value: 'hide', label: 'Hide Work', help: 'Takes matching works out of listings entirely.' },
  { value: 'collapse', label: 'Collapse', help: 'Folds matching works down to a line saying why, with a button to show them.' },
  { value: 'highlight', label: 'Highlight', help: 'Colours the match on each work, so it stands out. Hides nothing.' },
  { value: 'invert', label: 'Always show', help: 'Keeps matching works in sight when another rule would hide them, unless that rule has a higher priority.' },
  { value: 'hideFilter', label: 'Hide Tag', help: 'Leaves the works alone, and takes the tag itself out of their tag lists and the filter sidebar.' },
]

/** Why Hide Tag is inert for an author, a work or a series: there is no tag to take out. */
export const HIDE_TAG_OFF = 'Only for tags'

/** What Then's help says while the rule is switched off. */
export const RULE_OFF_HELP = 'The rule is off: it does nothing until Rule Enabled is on again.'

/** Whether a rule doing this highlights its match, so its colour is worth choosing. */
export function usesColor(action: RuleAction): boolean {
  return action === 'highlight' || action === 'invert'
}

/**
 * Whether a rule doing this has a priority: only the actions that enter the
 * contest over whether a work shows, which Highlight and Hide Tag never join.
 */
export function usesPriority(action: RuleAction): boolean {
  return ruleAffectsWorks({ behavior: action })
}

/** The highlight swatch picked: the target's default, a preset, or a colour of the reader's own. */
export type Swatch = 'default' | HighlightPreset['name'] | 'custom'

const sameColor = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The swatch a stored colour shows: Default for none, or for the target's
 * default itself (which saving stores as none); a preset for its own colour;
 * Custom for any other.
 */
export function swatchFor(color: string | undefined, targetDefault: string): Swatch {
  if (!color || sameColor(color, targetDefault))
    return 'default'
  return HIGHLIGHT_PRESETS.find(preset => sameColor(preset.color, color))?.name ?? 'custom'
}

/**
 * What the editor shows while it is open. `action` is what the rule does when
 * it is on, and holds still while `enabled` is off. `color` is the colour the
 * Custom picker shows. `kept` is the colour the rule was opened with, which a
 * disabled rule keeps while its action draws none.
 */
export interface RuleDraft {
  target: RuleTarget
  value: string
  /** An empty pseud is every pseud. */
  pseud: string
  matcher: Rule['matcher']
  action: RuleAction
  enabled: boolean
  priority: number
  swatch: Swatch
  color: string
  /** Always show's choice not to highlight its match, stored as the colour `transparent`. */
  noHighlight: boolean
  kept: string | undefined
}

/**
 * The draft the editor opens on: the rule's own fields, or for Add, a blank
 * rule for any tag. A disabled rule keeps nothing of what it did, so it opens
 * on Hide Work, which is what a rule with no behaviour does.
 */
export function openDraft(rule: Rule | undefined, colors: RuleColors): RuleDraft {
  const target = rule?.target ?? 'tag'
  const targetDefault = ruleTargetColor(target, colors)
  const own = rule?.color === 'transparent' ? undefined : rule?.color
  const behavior = rule?.behavior ?? 'hide'
  return {
    target,
    value: rule?.value ?? '',
    pseud: rule?.pseud ?? '',
    matcher: rule?.matcher ?? 'exact',
    action: behavior === 'none' ? 'hide' : behavior,
    enabled: behavior !== 'none',
    priority: rulePriority(rule ?? {}),
    swatch: swatchFor(own, targetDefault),
    color: own || targetDefault,
    noHighlight: rule?.color === 'transparent',
    kept: rule?.color,
  }
}

/**
 * Choosing what the rule does sets the priority that action implies, so an
 * Always show starts out above a plain hide. Choosing it again keeps a
 * priority typed over it. Hide Tag is refused for anything but a tag.
 */
export function withAction(draft: RuleDraft, action: RuleAction): RuleDraft {
  if (action === draft.action || (action === 'hideFilter' && !isTagTarget(draft.target)))
    return draft
  return { ...draft, action, priority: DEFAULT_BEHAVIOR_PRIORITY[action] }
}

/**
 * Changing what the rule applies to: Hide Tag falls back to Hide Work for an
 * author, a work or a series, and a pseud goes with an author.
 */
export function withTarget(draft: RuleDraft, target: RuleTarget): RuleDraft {
  const next = { ...draft, target, pseud: target === 'author' ? draft.pseud : '' }
  if (next.action === 'hideFilter' && !isTagTarget(target))
    return { ...next, action: 'hide', priority: DEFAULT_BEHAVIOR_PRIORITY.hide }
  return next
}

/** Picking a swatch. A preset also puts its colour in the picker, so Custom starts from it. */
export function withSwatch(draft: RuleDraft, swatch: Swatch): RuleDraft {
  const preset = HIGHLIGHT_PRESETS.find(p => p.name === swatch)
  return { ...draft, swatch, color: preset?.color ?? draft.color }
}

/** Whether the rule has something to match, without which it can't be saved. */
export function canSave(draft: RuleDraft): boolean {
  return draft.value.trim() !== ''
}

/** The colour the draft's action draws, as stored: none for the target's default. */
function actionColor(draft: RuleDraft, targetDefault: string): string | undefined {
  if (draft.action === 'invert' && draft.noHighlight)
    return 'transparent'
  const color = draft.swatch === 'default'
    ? undefined
    : draft.swatch === 'custom' ? draft.color : HIGHLIGHT_PRESETS.find(p => p.name === draft.swatch)!.color
  return color && !sameColor(color, targetDefault) ? color : undefined
}

/**
 * The rule saving the draft stores. What a rule would read as anyway is left
 * out: Hide Work, its action's own priority, the target's colour, every pseud.
 * Switched off, it is `behavior: 'none'` with its priority, and the colour its
 * action draws, or else the colour it was opened with, so turning it back on
 * gets them back.
 */
export function draftRule(draft: RuleDraft, colors: RuleColors): Rule {
  const behavior: FilterBehavior = draft.enabled ? draft.action : 'none'
  const color = usesColor(draft.action)
    ? actionColor(draft, ruleTargetColor(draft.target, colors))
    : draft.enabled ? undefined : draft.kept
  return {
    target: draft.target,
    value: draft.value,
    ...draft.target === 'author' && draft.pseud ? { pseud: draft.pseud } : {},
    matcher: draft.matcher,
    ...behavior === 'hide' ? {} : { behavior },
    ...draft.priority === DEFAULT_BEHAVIOR_PRIORITY[behavior] ? {} : { priority: draft.priority },
    ...color === undefined ? {} : { color },
  }
}

/** Whether a rule is about a work or a series, which it matches by title or by the id in its link. */
function isEntityTarget(target: RuleTarget): target is 'work' | 'series' {
  return target === 'work' || target === 'series'
}

/** Whether a work or series rule's text is a number, which matches the id in its link whatever the matcher. */
function matchesId(target: RuleTarget, value: string): boolean {
  return isEntityTarget(target) && /^\d+$/.test(value.trim())
}

/** What a rule's text is matched against, for each kind of target. */
function subjectNoun(target: RuleTarget): string {
  if (target === 'author')
    return 'username'
  return isEntityTarget(target) ? 'title' : 'name'
}

const PLACEHOLDERS: Partial<Record<RuleTarget, string>> = {
  author: 'Username',
  work: 'Work title or id',
  series: 'Series title or id',
}

/** What a tag's Exact field says of the name typed, by where its suggestions come from. */
const EXACT_HELP: Record<SuggestSource['kind'], string> = {
  ao3: 'Suggestions come from AO3’s tag autocomplete, so the rule uses AO3’s own spelling.',
  fixed: 'Suggestions are the archive’s own names, so the rule uses AO3’s own spelling.',
  none: 'The whole name, exactly as AO3 spells it.',
}

/**
 * The value field: its label, its placeholder, a line on how the matcher
 * reads what is typed, and whether the text matches by id (and the matcher
 * means nothing).
 */
export function valueField(target: RuleTarget, matcher: Rule['matcher'], value: string): { label: string, placeholder: string, help: string, byId: boolean } {
  const byId = matchesId(target, value)
  const noun = subjectNoun(target)
  const label = target === TagType.Fandom ? 'Fandom' : isTagTarget(target) ? 'Tag' : ruleTargetLabel(target)
  const suggestions = matcher === 'exact' ? suggestSource(target).kind : 'none'
  const placeholder = PLACEHOLDERS[target] ?? (suggestions === 'none' ? `${label} name` : `Start typing a ${label.toLowerCase()}…`)
  const help = byId
    ? `A number matches the ${target}’s id, from its link, whatever the matching.`
    : matcher === 'regex'
      ? `A regular expression, tested against each ${noun}, ignoring case.`
      : matcher === 'contains'
        ? `Matches any ${noun} that contains this text, ignoring case.`
        : target === 'author'
          ? 'The username from the author’s link, /users/username, exactly.'
          : isEntityTarget(target)
            ? `The whole title, exactly as AO3 shows it, or the id from the ${target}’s link.`
            : EXACT_HELP[suggestions]
  return { label, placeholder, help, byId }
}

/** What the regex tester says of the pattern against the text typed to test it. */
export type RegexVerdict = { kind: 'none' } | { kind: 'invalid', reason: string } | { kind: 'match' | 'miss' }

/** The flags a rule's regex runs under, which the engine names when it refuses a pattern. */
const RULE_REGEX_FLAGS = 'i'

/**
 * Why the engine refuses a pattern. V8 starts its message by repeating the
 * pattern ("Invalid regular expression: /(/i: Unterminated group"), and
 * SpiderMonkey's starts in lower case ("unterminated parenthetical").
 */
function refusal(pattern: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const preamble = `Invalid regular expression: /${pattern}/${RULE_REGEX_FLAGS}: `
  const reason = message.startsWith(preamble) ? message.slice(preamble.length) : message
  return reason.charAt(0).toUpperCase() + reason.slice(1)
}

/** The pattern compiled as a rule compiles it, or the engine's reason for refusing it. */
export function compilePattern(pattern: string): RegExp | string {
  try {
    return new RegExp(pattern, RULE_REGEX_FLAGS)
  }
  catch (error) {
    return refusal(pattern, error)
  }
}

/**
 * The regex tester's verdict, reached as a live rule reaches it
 * ({@link ruleValueMatches}). A pattern the engine refuses says so at once,
 * whatever is typed to test; a blank pattern, which can't be saved, or
 * nothing to test gives no verdict.
 */
export function regexVerdict(pattern: string, subject: string): RegexVerdict {
  const regex = compilePattern(pattern)
  if (typeof regex === 'string')
    return { kind: 'invalid', reason: regex }
  if (pattern.trim() === '' || subject === '')
    return { kind: 'none' }
  return { kind: ruleValueMatches({ value: pattern, matcher: 'regex' }, subject) ? 'match' : 'miss' }
}

/** What the regex tester shows: its field's placeholder, the verdict and the words on it, and the line under it. */
export interface RegexTester {
  placeholder: string
  verdict: RegexVerdict
  label: string
  help: string
}

const VERDICT_LABELS = { match: 'Matches', miss: 'No match', invalid: 'Invalid pattern' } as const

/**
 * The regex tester, in Regex mode, unless a work's or a series' number matches
 * its id and the matcher means nothing. It tests the pattern as the rule's live
 * matcher would: a work's or a series' trimmed, any other as typed.
 */
export function regexTester(draft: Pick<RuleDraft, 'target' | 'matcher' | 'value'>, subject: string): RegexTester | null {
  const { target, matcher, value } = draft
  if (matcher !== 'regex' || matchesId(target, value))
    return null
  const noun = isTagTarget(target) ? 'tag' : subjectNoun(target)
  const verdict = regexVerdict(isEntityTarget(target) ? value.trim() : value, subject)
  return {
    placeholder: `Type a ${noun} to test the pattern against`,
    verdict,
    label: verdict.kind !== 'none'
      ? VERDICT_LABELS[verdict.kind]
      : value.trim() === '' ? 'No pattern yet' : `Type a ${noun}`,
    help: verdict.kind === 'invalid' ? verdict.reason : 'Checks the pattern as you type. Nothing is saved from here.',
  }
}

/** Where the value field's suggestions come from: AO3's tag autocomplete, the archive's fixed names, or nowhere. */
export type SuggestSource = { kind: 'ao3', endpoint: string } | { kind: 'fixed', names: readonly string[] } | { kind: 'none' }

/**
 * AO3's autocomplete endpoint for each kind of tag that has one of its own. It
 * offers canonical tags only, and each keeps to its kind.
 */
const AUTOCOMPLETE_ENDPOINTS: Partial<Record<RuleTarget, string>> = {
  [TagType.Fandom]: '/autocomplete/fandom',
  [TagType.Character]: '/autocomplete/character',
  [TagType.Relationship]: '/autocomplete/relationship',
  [TagType.Freeform]: '/autocomplete/freeform',
}

/** The names a rating, an archive warning or a category can have: a set the archive keeps fixed, so there is nothing to ask. */
const FIXED_NAMES: Partial<Record<RuleTarget, readonly string[]>> = {
  [TagType.Rating]: ['General Audiences', 'Teen And Up Audiences', 'Mature', 'Explicit', 'Not Rated'],
  [TagType.ArchiveWarning]: ['Creator Chose Not To Use Archive Warnings', 'Graphic Depictions Of Violence', 'Major Character Death', 'No Archive Warnings Apply', 'Rape/Non-Con', 'Underage Sex'],
  [TagType.Category]: ['F/F', 'F/M', 'Gen', 'M/M', 'Multi', 'Other'],
}

/** Where suggestions for a rule's value come from. An author, a work or a series has none. */
export function suggestSource(target: RuleTarget): SuggestSource {
  // Any tag: AO3's plain `/autocomplete/tag` covers every kind (`type=all`
  // answers the same), but ranks names by how many of the typed words they
  // repeat, not by use, so the best-known fandom or character can miss its 16.
  if (target === 'tag')
    return { kind: 'ao3', endpoint: '/autocomplete/tag' }
  const endpoint = AUTOCOMPLETE_ENDPOINTS[target]
  if (endpoint)
    return { kind: 'ao3', endpoint }
  const names = FIXED_NAMES[target]
  return names ? { kind: 'fixed', names } : { kind: 'none' }
}

/**
 * The names in an answer from AO3's tag autocomplete, in its order: a list of
 * `{ id, name }`, whose id is the name again. Anything else is passed over, and
 * a name given twice is kept once.
 */
export function parseAutocomplete(json: unknown): string[] {
  if (!Array.isArray(json))
    return []
  const names = json
    .map((entry: unknown) => (typeof entry === 'object' && entry !== null && 'name' in entry ? entry.name : undefined))
    .filter((name): name is string => typeof name === 'string' && name !== '')
  return [...new Set(names)]
}

const quoted = (text: string) => (text.trim() ? `“${text}”` : '…')

/** The works a rule matches, as the end of a sentence: "every work tagged “Fluff” in Additional Tags". */
function matchedWorks(rule: Rule): string {
  const value = quoted(rule.value)
  const how = rule.matcher === 'regex' ? 'matches' : 'contains'
  if (matchesId(rule.target, rule.value))
    return rule.target === 'work' ? `the work with id ${rule.value.trim()}` : `every work in the series with id ${rule.value.trim()}`
  switch (rule.target) {
    case 'author': {
      const by = rule.matcher === 'exact' ? value : `an author whose username ${how} ${value}`
      return `every work by ${by}${rule.pseud ? ` writing as “${rule.pseud}”` : ''}`
    }
    case 'work':
      return rule.matcher === 'exact' ? `the work ${value}` : `every work whose title ${how} ${value}`
    case 'series':
      return rule.matcher === 'exact' ? `every work in the series ${value}` : `every work in a series whose title ${how} ${value}`
    default: {
      const where = rule.target === 'tag' ? '' : ` in ${ruleTargetLabel(rule.target)}`
      if (rule.matcher === 'exact')
        return `every work tagged ${value}${where}`
      return `every work with a tag ${rule.matcher === 'regex' ? 'matching' : 'containing'} ${value}${where}`
    }
  }
}

/** The tags a Hide Tag rule takes out: "the tag “Fluff” in Additional Tags". */
function matchedTags(rule: Rule): string {
  const value = quoted(rule.value)
  const where = rule.target === 'tag' ? '' : ` in ${ruleTargetLabel(rule.target)}`
  const tags = rule.matcher === 'exact' ? `the tag ${value}` : `every tag ${rule.matcher === 'regex' ? 'matching' : 'containing'} ${value}`
  return `${tags}${where}`
}

const VERBS: Record<'hide' | 'collapse' | 'invert', string> = { hide: 'Hide', collapse: 'Collapse', invert: 'Always show' }

/** A sentence's full stop, unless it already ends on the ellipsis standing for a value not typed yet. */
const stop = (sentence: string) => (sentence.endsWith('…') ? sentence : `${sentence}.`)

/**
 * What the rule does, in one sentence, for the reader to check before saving:
 * the action, the works or tags it acts on, and a priority where it isn't the
 * action's own.
 */
export function describeRule(rule: Rule): string {
  const behavior = rule.behavior ?? 'hide'
  switch (behavior) {
    case 'none':
      return stop(`Off: does nothing to ${matchedWorks(rule)}`)
    case 'highlight':
      return stop(`Highlight the match on ${matchedWorks(rule)}`)
    case 'hideFilter':
      return `Hide ${matchedTags(rule)} from tag lists and the filter sidebar; the works stay.`
    default: {
      const priority = rulePriority(rule)
      const tail = priority === DEFAULT_BEHAVIOR_PRIORITY[behavior] ? '' : `, at priority ${priority}`
      return stop(`${VERBS[behavior]} ${matchedWorks(rule)}${tail}`)
    }
  }
}
