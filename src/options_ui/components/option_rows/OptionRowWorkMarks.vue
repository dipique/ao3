<script setup lang="ts">
import type { MarkId } from '#common'

import { countIds, localMarkIds, markHidesResults, markIsLocal, markRoot, markTracksProgress, moveMark, reorderableMarkIds, SAVED_MARK } from '#common'

import { markIconClass } from '../../markIcons.ts'

const { enabled, marks } = useOption('workMarks')

/** The marks that hold their own work ids, in table order. */
const local = computed(() => localMarkIds(marks.value))

/** The marks that only configure how something else is drawn (Marked for Later). */
const external = computed(() => Object.keys(marks.value).filter(id => !markIsLocal(marks.value, id)))

/**
 * The marks whose place in the list is the reader's to choose — every verdict,
 * but not "ongoing", which is pinned after them.
 */
const movable = computed(() => reorderableMarkIds(marks.value))

/**
 * Move a mark one place through that run. Writes the whole table back rather
 * than nudging one field, because the order is renumbered from the result — and
 * the option store saves on any change to it either way.
 */
function move(id: MarkId, delta: number) {
  marks.value = moveMark(marks.value, id, delta)
}

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
 *
 * A progress mark is exempt from that clearing: it ships with an explicit
 * `hideSearchResult: true` that happens to differ from — or, if `read` is set to
 * hide, happens to match — what it would inherit, and deleting the field on a
 * match would silently hand its hiding over to an unrelated setting.
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
      if (root && v === inherited && !markTracksProgress(marks.value, id))
        delete config.hideSearchResult
      else
        config.hideSearchResult = v
    },
  })
}

const rows = computed(() => local.value.map((id) => {
  const at = movable.value.indexOf(id)
  return {
    id,
    label: label(id),
    icon: markIconClass(marks.value[id]?.icon),
    color: marks.value[id]?.color,
    count: count(id),
    alias: aliasOf(id),
    hide: hideModel(id),
    // A progress mark's hiding is a per-work decision (is there anything new to
    // read yet?), so the switch means something different enough to say so.
    hideLabel: markTracksProgress(marks.value, id) ? 'Hide until ready' : 'Hide in listings',
    hideAria: `Hide works marked ${label(id)} ${markTracksProgress(marks.value, id) ? 'until ready' : 'in listings'}`,
    tracksProgress: markTracksProgress(marks.value, id),
    // A pinned mark is in neither state, so its row draws the reason it can't
    // move rather than two permanently dead arrows.
    movable: at !== -1,
    canMoveUp: at > 0,
    canMoveDown: at !== -1 && at < movable.value.length - 1,
  }
}))

/**
 * Rough size of the packed sets. Marks live in the synced options, which share a
 * 100 KB quota across every setting, so this is shown once the list is big enough
 * to be worth knowing about rather than hidden away as a surprise later.
 *
 * Counts `progress` as well as `items`: a progress mark stores roughly as much
 * again in its payload, so summing only the ids would under-report by half.
 */
const packedKb = computed(() =>
  local.value.reduce(
    (sum, id) => sum + (marks.value[id]?.items?.length ?? 0) + (marks.value[id]?.progress?.length ?? 0),
    0,
  ) / 1024)
const showSize = computed(() => packedKb.value >= 1)

function clear(id: MarkId) {
  const n = count(id)
  const config = marks.value[id]
  // eslint-disable-next-line no-alert
  if (n && config && confirm(`Clear all ${n} "${label(id)}" marks? This can't be undone (a daily backup may still have them).`)) {
    config.items = ''
    // The payload is keyed by the ids just dropped, so it has to go with them —
    // otherwise every entry is orphaned, unreachable, and still costs quota.
    if (typeof config.progress === 'string')
      config.progress = ''
  }
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Work marks"
    subtitle="Mark a work read — or favorite, good, boring, bad, gross, ongoing — from its right-click (or long-press) menu. Works are also marked read automatically whenever you press AO3's own “Mark as Read” button, so your read list fills itself in as you browse."
  >
    <div flex="~ col gap-3" mt-2>
      <p text="sm muted-fg">
        A work carries one mark at a time: the finer dispositions all mean "read", so choosing one replaces whatever it
        had. Those take the work off your Marked for Later list, and — where "hide in listings" is on — collapse it out
        of results the same way your other rules do. An "always show" rule still wins over that.
      </p>

      <p text="sm muted-fg">
        "Ongoing" is the exception: it means you're waiting on more chapters, not that you're done. It keeps the work on
        your Marked for Later list (adding it if it isn't there) and records the last chapter you finished, plus an
        optional date to wait until. With "hide until ready" on, the work is collapsed only while there's nothing new to
        read or that date hasn't come round.
      </p>

      <p text="sm muted-fg">
        The arrows set the order the marks appear in — in a work's right-click menu, and wherever its marks are shown.
        "Ongoing" stays last, since it isn't one of the verdicts and shouldn't sit among them.
      </p>

      <div flex="~ col gap-2" text="sm" border-t pt-3>
        <div grid="~ cols-[min-content_1fr_min-content_min-content]" items-center gap-x-4 gap-y-2>
          <span text="xs muted-fg uppercase tracking-wide" ws-nowrap>Order</span>
          <span text="xs muted-fg uppercase tracking-wide">Mark</span>
          <span text="xs muted-fg uppercase tracking-wide" ws-nowrap>Hide</span>
          <span />

          <template v-for="row in rows" :key="row.id">
            <span v-if="row.movable" flex="~ col" items-center>
              <button
                class="input-ring"
                text="4 muted-fg hover:default-fg"
                cursor="pointer disabled:default" op="disabled:40"
                rounded-md p-0.5
                :disabled="!row.canMoveUp"
                :title="`Move ${row.label} up`"
                @click="move(row.id, -1)"
              >
                <Icon i-mdi-chevron-up :label="`Move ${row.label} up`" />
              </button>
              <button
                class="input-ring"
                text="4 muted-fg hover:default-fg"
                cursor="pointer disabled:default" op="disabled:40"
                rounded-md p-0.5
                :disabled="!row.canMoveDown"
                :title="`Move ${row.label} down`"
                @click="move(row.id, 1)"
              >
                <Icon i-mdi-chevron-down :label="`Move ${row.label} down`" />
              </button>
            </span>
            <span
              v-else
              flex="~ items-center justify-center"
              text="3 muted-fg"
              :title="`${row.label} always comes last — it isn't one of the read verdicts`"
            >
              <Icon i-mdi-pin-outline :label="`${row.label} is always last`" />
            </span>
            <span flex="~ items-center gap-2">
              <Icon :class="row.icon" :style="row.color ? { color: row.color } : undefined" />
              <span flex="~ col gap-0.5">
                <span>{{ row.label }}</span>
                <span text="xs muted-fg">
                  {{ row.count.toLocaleString() }} {{ row.count === 1 ? 'work' : 'works' }}<template v-if="row.tracksProgress"> · stays on Marked for Later</template><template v-else-if="row.alias"> · counts as {{ label(row.alias) }}</template>
                </span>
              </span>
            </span>
            <Switch v-model="row.hide.value" :title="row.hideLabel" :aria-label="row.hideAria" />
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
