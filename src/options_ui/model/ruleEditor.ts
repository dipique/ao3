import type { FilterBehavior, HighlightPreset, Rule, RuleColors, RuleTarget } from '../../common/data.ts'
import type { RegexRun } from './regexCheck.ts'

import { DEFAULT_BEHAVIOR_PRIORITY, HIGHLIGHT_PRESETS, isTagTarget, ruleAffectsWorks, rulePriority, ruleTargetColor, ruleTargetLabel, TagType } from '../../common/data.ts'
import { compilePattern } from './regexCheck.ts'

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
function hasValue(draft: Pick<RuleDraft, 'value'>): boolean {
  return draft.value.trim() !== ''
}

/** What the value field and Save say of a pattern stopped for running past its time budget. */
export const TOO_SLOW = 'Too slow to test: change the pattern to save the rule.'

/**
 * Whether a press of Save stores the rule now: it has something to match, and
 * a Regex pattern's check has run to the end in time. A press while the check
 * runs waits for it.
 */
export function canSave(draft: RuleDraft, run: RegexRun): boolean {
  return hasValue(draft) && (checkedPattern(draft) === null || run.kind === 'done')
}

/**
 * Save as drawn: off while there is nothing to match, and off with its reason
 * for a pattern stopped for running too long, until a check of a changed one
 * passes. A check under way after one that passed, or the first, leaves it on.
 */
export function saveButton(draft: RuleDraft, run: RegexRun): { off: boolean, reason: string | null } {
  const slow = checkedPattern(draft) !== null && (run.kind === 'slow' || (run.kind === 'running' && run.last?.kind === 'slow'))
  const reason = slow ? TOO_SLOW : null
  return { off: !hasValue(draft) || reason !== null, reason }
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

/**
 * The pattern a draft's check runs, as its live rule runs it: in Regex mode, a
 * work's or a series' trimmed, any other's as typed. None runs in another mode,
 * while a work's or a series' number matches its id, or for a blank pattern or
 * one the engine refuses.
 */
export function checkedPattern(draft: Pick<RuleDraft, 'target' | 'matcher' | 'value'>): string | null {
  const { target, matcher, value } = draft
  if (matcher !== 'regex' || matchesId(target, value))
    return null
  const pattern = isEntityTarget(target) ? value.trim() : value
  return pattern.trim() === '' || typeof compilePattern(pattern) === 'string' ? null : pattern
}

/**
 * The names a draft's pattern is checked over beside the tester's subject: for
 * a tag, the names known here for its target (`known`), null while they load;
 * for an author, a work or a series, none.
 */
export function checkedNames(target: RuleTarget, known: { target: RuleTarget, names: readonly string[] } | null): readonly string[] | null {
  if (!isTagTarget(target))
    return []
  return known?.target === target ? known.names : null
}

/** What the regex tester says of the pattern against the text typed to test it. */
export type RegexVerdict = { kind: 'none' } | { kind: 'invalid', reason: string } | { kind: 'match' | 'miss' | 'slow' | 'checking' }

/**
 * The regex tester's verdict on `subject`, from the run of the pattern's
 * check, which tests it as a live rule does (`ruleValueMatches`). A pattern the
 * engine refuses says so at once, whatever is typed to test; a blank pattern,
 * which can't be saved, gives no verdict, nor does nothing to test. Past its
 * time budget, a pattern is too slow, whatever is typed; while its check runs,
 * what is typed is being checked.
 */
export function regexVerdict(pattern: string, subject: string, run: RegexRun): RegexVerdict {
  const regex = compilePattern(pattern)
  if (typeof regex === 'string')
    return { kind: 'invalid', reason: regex }
  if (pattern.trim() === '')
    return { kind: 'none' }
  if (run.kind === 'slow')
    return { kind: 'slow' }
  if (subject === '' || run.kind === 'idle')
    return { kind: 'none' }
  if (run.kind === 'running')
    return { kind: 'checking' }
  const span = run.matches.get(subject)
  return span === undefined ? { kind: 'checking' } : { kind: span ? 'match' : 'miss' }
}

/** What the regex tester shows: its field's placeholder, the verdict and the words on it, and the line under it. */
export interface RegexTester {
  placeholder: string
  verdict: RegexVerdict
  label: string
  help: string
}

/** What the tester, and the canonical tags' preview, say while a check of the pattern runs. */
export const CHECKING = 'Checking…'

const VERDICT_LABELS = { match: 'Matches', miss: 'No match', invalid: 'Invalid pattern', slow: 'Too slow', checking: CHECKING } as const

const TESTER_HELP = 'Checks the pattern as you type. Nothing is saved from here.'

/**
 * The regex tester, in Regex mode, unless a work's or a series' number matches
 * its id and the matcher means nothing. It tests the pattern as the rule's live
 * matcher would: a work's or a series' trimmed, any other as typed. `run` is
 * the run of the draft's check, whose names include `subject`.
 */
export function regexTester(draft: Pick<RuleDraft, 'target' | 'matcher' | 'value'>, subject: string, run: RegexRun): RegexTester | null {
  const { target, matcher, value } = draft
  if (matcher !== 'regex' || matchesId(target, value))
    return null
  const noun = isTagTarget(target) ? 'tag' : subjectNoun(target)
  const verdict = regexVerdict(isEntityTarget(target) ? value.trim() : value, subject, run)
  return {
    placeholder: `Type a ${noun} to test the pattern against`,
    verdict,
    label: verdict.kind !== 'none'
      ? VERDICT_LABELS[verdict.kind]
      : value.trim() === '' ? 'No pattern yet' : `Type a ${noun}`,
    help: verdict.kind === 'invalid'
      ? verdict.reason
      : verdict.kind === 'slow' ? 'Testing stopped: the pattern took too long.' : TESTER_HELP,
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

/** A piece of a rule's sentence: its action, drawn bold; the value it matches, drawn as a quote; or the words between. */
export interface SummaryPart { text: string, kind?: 'verb' | 'value' }

const words = (text: string): SummaryPart => ({ text })
const quoted = (text: string): SummaryPart => (text.trim() ? { text: `“${text}”`, kind: 'value' } : words('…'))

/** The works a rule matches, as the end of a sentence: "every work tagged “Fluff” in Additional Tags". */
function matchedWorks(rule: Rule): SummaryPart[] {
  const value = quoted(rule.value)
  const how = rule.matcher === 'regex' ? 'matches' : 'contains'
  if (matchesId(rule.target, rule.value))
    return [words(rule.target === 'work' ? `the work with id ${rule.value.trim()}` : `every work in the series with id ${rule.value.trim()}`)]
  switch (rule.target) {
    case 'author': {
      const by = rule.matcher === 'exact' ? [value] : [words(`an author whose username ${how} `), value]
      return [words('every work by '), ...by, ...(rule.pseud ? [words(` writing as “${rule.pseud}”`)] : [])]
    }
    case 'work':
      return rule.matcher === 'exact' ? [words('the work '), value] : [words(`every work whose title ${how} `), value]
    case 'series':
      return rule.matcher === 'exact' ? [words('every work in the series '), value] : [words(`every work in a series whose title ${how} `), value]
    default: {
      const where = rule.target === 'tag' ? [] : [words(` in ${ruleTargetLabel(rule.target)}`)]
      if (rule.matcher === 'exact')
        return [words('every work tagged '), value, ...where]
      return [words(`every work with a tag ${rule.matcher === 'regex' ? 'matching' : 'containing'} `), value, ...where]
    }
  }
}

/** The tags a Hide Tag rule takes out: "the tag “Fluff” in Additional Tags". */
function matchedTags(rule: Rule): SummaryPart[] {
  const value = quoted(rule.value)
  const where = rule.target === 'tag' ? [] : [words(` in ${ruleTargetLabel(rule.target)}`)]
  const tags = rule.matcher === 'exact' ? [words('the tag '), value] : [words(`every tag ${rule.matcher === 'regex' ? 'matching' : 'containing'} `), value]
  return [...tags, ...where]
}

const VERBS: Record<'hide' | 'collapse' | 'invert', string> = { hide: 'Hide', collapse: 'Collapse', invert: 'Always show' }

/**
 * A sentence of parts, its words run together where two meet, and its full
 * stop, unless it already ends on the ellipsis standing for a value not typed
 * yet.
 */
function sentenceOf(verb: string, ...rest: SummaryPart[]): SummaryPart[] {
  const parts: SummaryPart[] = [{ text: verb, kind: 'verb' }]
  for (const part of [...rest, words('.')]) {
    const last = parts.at(-1)!
    if (part.text === '.' && last.text.endsWith('…'))
      break
    if (!part.kind && !last.kind)
      parts[parts.length - 1] = words(last.text + part.text)
    else
      parts.push(part)
  }
  return parts
}

/**
 * What the rule does, in one sentence, for the reader to check before saving,
 * in parts: the action, the works or tags it acts on, and a priority where it
 * isn't the action's own.
 */
export function ruleSummary(rule: Rule): SummaryPart[] {
  const behavior = rule.behavior ?? 'hide'
  switch (behavior) {
    case 'none':
      return sentenceOf('Off', words(': does nothing to '), ...matchedWorks(rule))
    case 'highlight':
      return sentenceOf('Highlight', words(' the match on '), ...matchedWorks(rule))
    case 'hideFilter':
      return sentenceOf('Hide', words(' '), ...matchedTags(rule), words(' from tag lists and the filter sidebar; the works stay'))
    default: {
      const priority = rulePriority(rule)
      const tail = priority === DEFAULT_BEHAVIOR_PRIORITY[behavior] ? [] : [words(`, at priority ${priority}`)]
      return sentenceOf(VERBS[behavior], words(' '), ...matchedWorks(rule), ...tail)
    }
  }
}

/** {@link ruleSummary}'s sentence as one string. */
export function describeRule(rule: Rule): string {
  return ruleSummary(rule).map(part => part.text).join('')
}
