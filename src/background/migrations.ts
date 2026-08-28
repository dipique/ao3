import type { cache, Language, Rule, RuleColors, RuleTarget, TagType as TagTypeT } from '#common'

import { createDefaultMarks, DEFAULT_RULE_COLORS, filterFromInvert, isTagTarget, normalizeMarkOrder, packIds, RULE_TARGETS, TagType, unpackIds } from '#common'

/** The pre-merge `hideAuthors` filter shape. */
interface LegacyAuthorFilter { userId: string, pseud?: string, behavior?: Rule['behavior'], color?: string }
/** The pre-merge `hideTags` filter shape. */
interface LegacyTagFilter { name: string, type?: TagTypeT, matcher: Rule['matcher'], behavior?: Rule['behavior'], color?: string }
/** The pre-merge `hideWorks` / `hideSeries` filter shape. */
interface LegacyEntityFilter { value: string, matcher: Rule['matcher'], behavior?: Rule['behavior'], color?: string }
/** The pre-merge shape shared by all four lists. */
interface LegacyList<F> { enabled?: boolean, filters?: F[], defaultHighlightColor?: string }

export async function migrate() {
  // Removed in 0.4.0
  await browser.storage.local.remove([
    'cache.kudosChecked',
    'cache.workPagesChecked',
    'cache.kudosGiven',
    'cache.bookmarked',
    'cache.subscribed',
  ])

  // In 0.5.0 we changed chapterDates to no longer be jsoned
  const key = `cache.chapterDates` as cache.Id
  const { [key]: val } = await browser.storage.local.get(key)
  if (typeof val === 'string') {
    const parsed = JSON.parse(val)
    await browser.storage.local.set({ [key]: parsed })
  }

  // In 0.5.0 we changed how hideWorks stores data
  const data = await browser.storage.local.get([
    'option.hideAuthors',
    'option.hideAuthorsList',
    'option.hideCrossovers',
    'option.hideCrossoversMaxFandoms',
    'option.hideLanguages',
    'option.hideLanguagesList',
    'option.hideTags',
    'option.hideTagsAllowList',
    'option.hideTagsDenyList',
  ])
  if (typeof data['option.hideAuthors'] === 'boolean') {
    const list = JSON.parse(data['option.hideAuthorsList']) as unknown
    const filters: LegacyAuthorFilter[] = Array.isArray(list)
      ? list.map(l => ({
          userId: l,
        }))
      : []
    await browser.storage.local.set({
      'option.hideAuthors': { enabled: data['option.hideAuthors'], filters },
    })
    await browser.storage.local.remove(['option.hideAuthorsList'])
  }
  if (typeof data['option.hideCrossovers'] === 'boolean') {
    const maxFandoms = data['option.hideCrossoversMaxFandoms']
    await browser.storage.local.set({
      'option.hideCrossovers': { enabled: data['option.hideCrossovers'], maxFandoms },
    })
    await browser.storage.local.remove(['option.hideCrossoversMaxFandoms'])
  }
  if (typeof data['option.hideLanguages'] === 'boolean') {
    const list = JSON.parse(data['option.hideLanguagesList']) as { text: string, value: string }[]
    const show: Language[] = Array.isArray(list)
      ? list.map(l => ({ label: l.text, value: l.value }))
      : []
    await browser.storage.local.set({
      'option.hideLanguages': { enabled: data['option.hideLanguages'], show },
    })
    await browser.storage.local.remove(['option.hideLanguagesList'])
  }
  if (typeof data['option.hideTags'] === 'boolean') {
    type OldTagType = 'fandom' | 'warning' | 'category' | 'relationship' | 'character' | 'freeform' | 'unknown'
    const oldTypeToNewType = (old: OldTagType) => {
      switch (old) {
        case 'fandom': return TagType.Fandom
        case 'warning': return TagType.ArchiveWarning
        case 'category': return TagType.Category
        case 'relationship': return TagType.Relationship
        case 'character': return TagType.Character
        case 'freeform': return TagType.Freeform
        default: return undefined
      }
    }
    const denyList = JSON.parse(data['option.hideTagsDenyList']) as ({ tag: string, type: OldTagType } | string)[]
    const allowList = JSON.parse(data['option.hideTagsAllowList']) as ({ tag: string, type: OldTagType } | string)[]
    const filters: (LegacyTagFilter & { invert?: boolean })[] = []
    if (Array.isArray(denyList)) {
      filters.push(...denyList.map(l => ({
        name: typeof l === 'string' ? l : l.tag,
        type: oldTypeToNewType(typeof l === 'string' ? 'unknown' : l.type),
        matcher: 'exact' as const,
      })))
    }
    if (Array.isArray(allowList)) {
      filters.push(...allowList.map(l => ({
        name: typeof l === 'string' ? l : l.tag,
        type: oldTypeToNewType(typeof l === 'string' ? 'unknown' : l.type),
        matcher: 'exact' as const,
        invert: true,
      })))
    }
    await browser.storage.local.set({
      'option.hideTags': { enabled: data['option.hideTags'], filters },
    })
    await browser.storage.local.remove(['option.hideTagsAllowList', 'option.hideTagsDenyList'])
  }

  // In 0.5.0 we stopped JSONing
  const theme = await browser.storage.local.get(['option.theme'])
  if (typeof theme['option.theme'] === 'string') {
    const parsed = JSON.parse(theme['option.theme'])
    await browser.storage.local.set({ 'option.theme': parsed })
  }
  const user = await browser.storage.local.get(['option.user'])
  if (typeof user['option.user'] === 'string') {
    const parsed = JSON.parse(user['option.user'])
    if (typeof parsed === 'object' && parsed !== null && 'username' in parsed) {
      await browser.storage.local.set({ 'option.user': { userId: parsed.username } })
    }
    else {
      await browser.storage.local.set({ 'option.user': {} })
    }
  }

  // 0.5.4 had a bug where tag filters were not being migrated correctly
  // https://github.com/jsmnbom/ao3-enhancements/issues/75
  // Unfortunately the code deleted the old filters so we can't fix it now
  // But we can clean up the options so that the rest of the code at least will work again
  if (typeof data['option.hideTags'] === 'object' && Array.isArray(data['option.hideTags'].filters) && data['option.hideTags'].filters.length > 0) {
    if (data['option.hideTags'].filters.some((f: any) => f.matcher === 'exact' && f.name === undefined)) {
      await browser.storage.local.set({
        'option.hideTags': {
          enabled: data['option.hideTags'].enabled,
          filters: data['option.hideTags'].filters.filter((f: any) => {
            return f.matcher === 'exact' && f.name !== undefined
          }),
        },
      })
    }
  }

  // Tag and author filters moved from a boolean `invert` flag to a `behavior`
  // field (which also introduces 'highlight'). `filterFromInvert` maps any
  // leftover `invert` onto `behavior` without overriding an existing behavior,
  // and is idempotent on filters that have none — so re-running after conversion
  // is a no-op. This is also the path that normalises upstream-shaped data on
  // import (the import flow runs these migrations after loading the file).
  for (const key of ['option.hideTags', 'option.hideAuthors', 'option.hideWorks', 'option.hideSeries'] as const) {
    const stored = (await browser.storage.local.get(key))[key] as
      { enabled: boolean, filters: Array<Record<string, unknown>> } | undefined
    if (stored && Array.isArray(stored.filters) && stored.filters.some(f => 'invert' in f)) {
      const filters = stored.filters.map(f => filterFromInvert(f))
      await browser.storage.local.set({ [key]: { ...stored, filters } })
    }
  }

  await migrateRules()
  await migrateWorkMarks()
}

/**
 * The four filter lists (`hideTags`, `hideAuthors`, `hideWorks`, `hideSeries`)
 * became one Rules list, where what a rule matches is a `target` field rather
 * than which list it lives in. Each list's `defaultHighlightColor` becomes the
 * default colour for the targets it used to cover — the tag colour spreading
 * across every tag type — so the colours stay data keyed by target instead of
 * four separate settings.
 *
 * Runs after the `invert` → `behavior` pass above, so every legacy filter has
 * already been normalised by the time it's folded in. Idempotent: the old keys
 * are removed once merged, and rules already in `option.rules` are kept.
 */
async function migrateRules(): Promise<void> {
  const LEGACY_KEYS = ['option.hideTags', 'option.hideAuthors', 'option.hideWorks', 'option.hideSeries'] as const
  const stored = await browser.storage.local.get([...LEGACY_KEYS, 'option.rules'])
  if (!LEGACY_KEYS.some(key => stored[key] !== undefined))
    return

  const existing = stored['option.rules'] as { enabled?: boolean, filters?: Rule[], colors?: RuleColors } | undefined
  const filters: Rule[] = Array.isArray(existing?.filters) ? [...existing.filters] : []
  const colors: RuleColors = { ...(existing?.colors ?? {}) }
  let enabled = !!existing?.enabled

  /** Record a legacy list's default colour against the targets it used to cover. */
  const setColor = (color: string | undefined, targets: RuleTarget[]) => {
    if (!color)
      return
    for (const target of targets) {
      // Skip a colour that already equals the built-in — nothing to remember.
      if (color !== DEFAULT_RULE_COLORS[target])
        colors[target] = color
    }
  }

  const tags = stored['option.hideTags'] as LegacyList<LegacyTagFilter> | undefined
  if (tags) {
    enabled ||= !!tags.enabled
    setColor(tags.defaultHighlightColor, RULE_TARGETS.filter(isTagTarget))
    for (const f of tags.filters ?? []) {
      if (typeof f?.name !== 'string')
        continue
      filters.push(clean({ target: f.type ?? 'tag', value: f.name, matcher: f.matcher ?? 'exact', behavior: f.behavior, color: f.color }))
    }
  }

  const authors = stored['option.hideAuthors'] as LegacyList<LegacyAuthorFilter> | undefined
  if (authors) {
    enabled ||= !!authors.enabled
    setColor(authors.defaultHighlightColor, ['author'])
    for (const f of authors.filters ?? []) {
      if (typeof f?.userId !== 'string')
        continue
      filters.push(clean({ target: 'author', value: f.userId, pseud: f.pseud, matcher: 'exact', behavior: f.behavior, color: f.color }))
    }
  }

  for (const [key, target] of [['option.hideWorks', 'work'], ['option.hideSeries', 'series']] as const) {
    const list = stored[key] as LegacyList<LegacyEntityFilter> | undefined
    if (!list)
      continue
    enabled ||= !!list.enabled
    setColor(list.defaultHighlightColor, [target])
    for (const f of list.filters ?? []) {
      if (typeof f?.value !== 'string')
        continue
      filters.push(clean({ target, value: f.value, matcher: f.matcher ?? 'exact', behavior: f.behavior, color: f.color }))
    }
  }

  await browser.storage.local.set({ 'option.rules': { enabled, filters, colors } })
  await browser.storage.local.remove([...LEGACY_KEYS])
}

/** Drop the undefined fields so migrated rules match hand-written ones byte for byte. */
function clean(rule: Rule): Rule {
  return Object.fromEntries(Object.entries(rule).filter(([, v]) => v !== undefined)) as unknown as Rule
}

/**
 * `workMarks` went from two hard-coded id sets (`read`, `favorite`) plus a
 * `hideRead` switch to a table of marks, each declaring its own icon, colour,
 * whether it hides results, and which mark it behaves as.
 *
 * A favourite was always a work you'd read, so under the new "one disposition
 * per work" rule the favourites come out of `read` rather than sitting in both.
 * Also tops up an already-migrated table with any mark added since, so a new
 * default mark reaches an existing install.
 */
async function migrateWorkMarks(): Promise<void> {
  const key = 'option.workMarks'
  const stored = (await browser.storage.local.get(key))[key] as Record<string, any> | undefined
  if (!stored || typeof stored !== 'object')
    return

  if (stored.marks && typeof stored.marks === 'object') {
    // Already migrated — only fill in marks that didn't exist when it was
    // written. A stored mark wins whole, which is what keeps the order the
    // reader chose (it rides along in each mark's `order`); normalizing after
    // the merge settles the slots a newly shipped mark lands on top of.
    const marks = normalizeMarkOrder({ ...createDefaultMarks(), ...stored.marks })
    await browser.storage.local.set({ [key]: { ...stored, marks } })
    return
  }

  const marks = createDefaultMarks()
  const favorites = unpackIds(typeof stored.favorite === 'string' ? stored.favorite : '')
  const read = [...unpackIds(typeof stored.read === 'string' ? stored.read : '')].filter(id => !favorites.has(id))
  marks.read!.items = packIds(read)
  marks.read!.hideSearchResult = !!stored.hideRead
  marks.favorite!.items = packIds(favorites)

  await browser.storage.local.set({ [key]: { enabled: !!stored.enabled, marks } })
}
