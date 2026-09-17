import { debounce, objectEntries } from '@antfu/utils'
import type { Ref, ToRefs } from 'vue'

import type { Options } from '#common'

import { createLogger, deepToRaw, options, toast } from '#common'

const logger = createLogger('useOptions')

let loading = true
const ready = ref(false)
const scope = effectScope(true)
// A copy, never the defaults themselves: `reactive()` on the shared object would
// make every later reader of `options.defaults` — in this context, including the
// one the sync codec prunes against — see whatever this page edited.
const allOptions = reactive(structuredClone(options.defaults)) as Options
const changedOptions: Set<options.Id> = new Set()
/**
 * Keys this page is applying on someone else's behalf right now.
 *
 * Assigning one trips the same watcher a reader's own edit does, and that echo
 * must not be written back. Marked synchronously and cleared on the next tick —
 * the tick the watchers flush in — so there is never a window in which a real
 * edit is dropped, which is what a timer here used to cause.
 */
const applying: Set<options.Id> = new Set()

const save = debounce(200, () => {
  if (loading)
    return false

  const keys = [...changedOptions]
  changedOptions.clear()
  const toSet = Object.fromEntries(keys.map(key => [key, deepToRaw(allOptions[key])]))
  logger.log('Saving:', toSet)

  void options.set(toSet)
    .then(() => toast('Options saved', { type: 'success' }))
    .catch((error: unknown) => {
      // Put them back, so the next edit carries them too and the batch isn't
      // simply gone — and say so. A write that fails in silence looks exactly
      // like one that worked, with the new value still on screen.
      for (const key of keys)
        changedOptions.add(key)
      logger.error('Saving failed:', error)
      toast('Your settings could not be saved — see the console for details', { type: 'error' })
    })
})

function update(id: options.Id) {
  if (loading)
    return false

  // Our own echo of a change that came from somewhere else. One watcher fire per
  // assignment, so the mark is consumed rather than left to catch a later edit.
  if (applying.delete(id))
    return false

  logger.log('Update:', id)
  changedOptions.add(id)
  save()
}

function assign(id: options.Id, value: Options[options.Id] | undefined) {
  if (isReactive(allOptions[id])) {
    if (value === undefined || value === null) {
      return
    }

    Object.assign(allOptions[id] as any, value)
  }
  else {
    (allOptions[id] as any) = value
  }
}

export function useOption<K extends options.Id>(id: K): Options[K] extends object ? ToRefs<Options[K]> : Ref<Options[K]> {
  const val = allOptions[id] as object

  return isReactive(val) ? toRefs(val) as any : toRef(allOptions, id) as any
}

export function useOptionsReady() {
  return ready
}

/**
 * Take in a change made somewhere else — a sync pull, the content script, this
 * extension's own background.
 *
 * Nothing here is timed. A key with an edit of ours still waiting to be written
 * is skipped, because ours is the newer of the two and about to land; everything
 * else is assigned, and the watcher that assignment trips is swallowed through
 * {@link applying}. The echo of this page's *own* write arrives here like any
 * other change and is dropped the same way, which is why there is no longer a
 * "saving" flag standing in front of this.
 */
function externalListener(change: Partial<Options>) {
  if (loading)
    return

  logger.info('[external] change:', change)

  for (const [id, value] of objectEntries(change))
    applyExternal(id, value)

  void nextTick(() => applying.clear())
}

/** Assign one externally-changed key, unless this page holds something newer for it. */
function applyExternal(id: options.Id, value: Options[options.Id] | undefined) {
  if (changedOptions.has(id))
    return
  applying.add(id)
  assign(id, value)
}

/**
 * The options store mutes `theme`/`user` change events ({@link options}'s
 * `ignoredEvents`) so the content script doesn't re-run every unit when
 * `OptionsUpdater` writes the detected theme/user. The options page, though, must
 * still reflect those — e.g. a theme adopted from another device via sync — so we
 * pick the ignored keys up straight from storage here.
 */
function ignoredListener(changes: { [key: string]: browser.storage.StorageChange }, areaName: string) {
  if (areaName !== options.area || loading)
    return

  let touched = false
  for (const id of options.ignoredEvents ?? []) {
    const change = changes[`${options.prefix}${id}`]
    if (change) {
      applyExternal(id, change.newValue)
      touched = true
    }
  }
  if (touched)
    void nextTick(() => applying.clear())
}

function load() {
  loading = true
  logger.log('Loading...')

  void options.get().then((opts) => {
    scope.run(() => {
      for (const [id, value] of objectEntries(opts)) {
        assign(id, value)
        watch(() => allOptions[id], () => update(id), { deep: true })
      }

      logger.log('[external] Attaching listener')
      options.addListener(externalListener)
      onScopeDispose(() => options.removeListener(externalListener))

      browser.storage.onChanged.addListener(ignoredListener)
      onScopeDispose(() => browser.storage.onChanged.removeListener(ignoredListener))

      ready.value = true
      logger.log('Ready!')

      void nextTick(() => loading = false)
    })
  })
}

if (import.meta.hot) {
  logger.log('[hot] Available!')
  import.meta.hot.on('vite:beforeUpdate', () => {
    logger.log('[hot] Disposing...')
    scope.stop()
  })
  import.meta.hot.on('vite:afterUpdate', () => {
    logger.log('[hot] Re-loading...')
    load()
  })
}

load()
