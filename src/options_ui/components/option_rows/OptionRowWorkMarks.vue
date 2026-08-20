<script setup lang="ts">
import type { MarkId } from '#common'

import { countIds, localMarkIds, markHidesResults, markIsLocal, markRoot, SAVED_MARK } from '#common'

import { markIconClass } from '../../markIcons.ts'

const { enabled, marks } = useOption('workMarks')

/** The marks that hold their own work ids, in table order. */
const local = computed(() => localMarkIds(marks.value))

/** The marks that only configure how something else is drawn (Marked for Later). */
const external = computed(() => Object.keys(marks.value).filter(id => !markIsLocal(marks.value, id)))

/** The ids are stored delta-packed, so a count is a split — no need to unpack. */
function count(id: MarkId): number {
  return countIds(marks.value[id]?.items ?? '')
}

function label(id: MarkId): string {
  return marks.value[id]?.label || id
}

/**
 * The mark this one behaves as, when that isn't itself — the marks aliased to
 * `read` are the same disposition said more precisely, so they inherit its
 * "hide in listings" setting until you set their own.
 */
function aliasOf(id: MarkId): MarkId | null {
  const root = markRoot(marks.value, id)
  return root === id ? null : root
}

/**
 * Whether works carrying this mark are collapsed out of listings. Reads through
 * the alias, and writing the inherited value back clears the override so the
 * mark goes on following its root.
 */
function hideModel(id: MarkId) {
  return computed({
    get: () => markHidesResults(marks.value, id),
    set: (v: boolean) => {
      const root = aliasOf(id)
      const inherited = root ? !!marks.value[root]?.hideSearchResult : false
      const config = marks.value[id]
      if (!config)
        return
      if (root && v === inherited)
        delete config.hideSearchResult
      else
        config.hideSearchResult = v
    },
  })
}

const rows = computed(() => local.value.map(id => ({
  id,
  label: label(id),
  icon: markIconClass(marks.value[id]?.icon),
  color: marks.value[id]?.color,
  count: count(id),
  alias: aliasOf(id),
  hide: hideModel(id),
})))

/**
 * Rough size of the packed sets. Marks live in the synced options, which share a
 * 100 KB quota across every setting, so this is shown once the list is big enough
 * to be worth knowing about rather than hidden away as a surprise later.
 */
const packedKb = computed(() =>
  local.value.reduce((sum, id) => sum + (marks.value[id]?.items?.length ?? 0), 0) / 1024)
const showSize = computed(() => packedKb.value >= 1)

function clear(id: MarkId) {
  const n = count(id)
  const config = marks.value[id]
  // eslint-disable-next-line no-alert
  if (n && config && confirm(`Clear all ${n} "${label(id)}" marks? This can't be undone (a daily backup may still have them).`))
    config.items = ''
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Work marks"
    subtitle="Mark a work read — or favorite, good, boring, bad, gross — from its right-click (or long-press) menu. Works are also marked read automatically whenever you press AO3's own “Mark as Read” button, so your read list fills itself in as you browse."
  >
    <div flex="~ col gap-3" mt-2>
      <p text="sm muted-fg">
        A work carries one mark at a time: the finer dispositions all mean "read", so choosing one replaces whatever it
        had. Any of them takes the work off your Marked for Later list, and — where "hide in listings" is on — collapses
        it out of results the same way your other rules do. An "always show" rule still wins over that.
      </p>

      <div flex="~ col gap-2" text="sm" border-t pt-3>
        <div grid="~ cols-[1fr_min-content_min-content]" items-center gap-x-4 gap-y-2>
          <span text="xs muted-fg uppercase tracking-wide">Mark</span>
          <span text="xs muted-fg uppercase tracking-wide" ws-nowrap>Hide in listings</span>
          <span />

          <template v-for="row in rows" :key="row.id">
            <span flex="~ items-center gap-2">
              <Icon :class="row.icon" :style="row.color ? { color: row.color } : undefined" />
              <span flex="~ col gap-0.5">
                <span>{{ row.label }}</span>
                <span text="xs muted-fg">
                  {{ row.count.toLocaleString() }} {{ row.count === 1 ? 'work' : 'works' }}<template v-if="row.alias"> · counts as {{ label(row.alias) }}</template>
                </span>
              </span>
            </span>
            <Switch v-model="row.hide.value" :aria-label="`Hide works marked ${row.label} in listings`" />
            <Button
              variant="outline"
              size="sm"
              :disabled="row.count === 0"
              @click="clear(row.id)"
            >
              Clear
            </Button>
          </template>
        </div>

        <p v-if="external.length" text="xs muted-fg" border-t pt-3>
          <template v-for="id in external" :key="id">
            <Icon :class="markIconClass(marks[id]?.icon)" />
            {{ label(id) }}<span v-if="id === SAVED_MARK"> lives on AO3, not here — this entry only says how it is drawn on results.</span>
          </template>
        </p>

        <p text="xs muted-fg">
          Marks are stored with your settings, so they're included in backups and sync.
          <template v-if="showSize">
            They currently take about {{ packedKb.toFixed(1) }}&nbsp;KB (compressed further before syncing, which has a
            100&nbsp;KB budget for all settings combined).
          </template>
        </p>
      </div>
    </div>
  </OptionRowCollapsable>
</template>
