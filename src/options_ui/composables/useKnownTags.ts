import type { Ref } from 'vue'

import type { RuleTarget } from '#common'

import { fandomCache, isTagTarget, loadFandomIndex } from '#common'

import type { KnownTags, PoolTag } from '../model/canonicalTags.ts'

import { canonicalPool, knownOnce, usesBundledFandoms } from '../model/canonicalTags.ts'

let bundled: Promise<readonly string[]> | null = null

/** The bundled fandoms' names, read once for the page. A read that fails is tried again at the next load. */
function bundledFandoms(): Promise<readonly string[]> {
  bundled ??= loadFandomIndex().then(Object.keys, (error: unknown) => {
    bundled = null
    console.error('[rule editor] Failed to load the bundled fandom index:', error)
    return []
  })
  return bundled
}

async function knownTags(target: RuleTarget): Promise<KnownTags> {
  const [names, learned] = await Promise.all([usesBundledFandoms(target) ? bundledFandoms() : [], fandomCache.get()])
  return { bundled: names, learned }
}

/** The names known here for a kind of tag, each once ({@link knownOnce}): as tags, and as the names a pattern runs over. */
export interface KnownPool {
  target: RuleTarget
  tags: readonly PoolTag[]
  names: readonly string[]
}

/**
 * The names known here for the rule editor's target, loaded while the editor
 * is open on a kind of tag ({@link canonicalPool}): its check runs a Regex
 * pattern over them, and the canonical-tag preview shows those it matches.
 * They load as the editor opens, or its target changes, so a pattern typed
 * next has them to be checked against. Null while they load, and for a target
 * that isn't a tag.
 */
export function useKnownTags(target: () => RuleTarget, open: Ref<boolean>) {
  const known = shallowRef<KnownPool | null>(null)
  /** Counts loads, so an earlier load lands only if it is still the latest. */
  let loads = 0

  watch([open, target], async ([isOpen, kind]) => {
    const load = ++loads
    known.value = null
    if (!isOpen || !isTagTarget(kind))
      return
    const tags = knownOnce(canonicalPool(kind, await knownTags(kind)))
    if (load === loads)
      known.value = { target: kind, tags, names: tags.map(tag => tag.name) }
  }, { immediate: true })

  return known
}
