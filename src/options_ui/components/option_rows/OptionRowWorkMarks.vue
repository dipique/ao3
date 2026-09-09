<script setup lang="ts">
import type { ComponentInstance, GlobalComponents } from 'vue'

import type { MarkId } from '#common'

import { addMark, countIds, DEFAULT_MARK_ICON, localMarkIds, MARK_ICON_NAMES, markHidesResults, markIconClassName, markIdFor, markIsLocal, markIsOffered, markNameError, markRoot, markTracksProgress, moveMark, reorderableMarkIds, SAVED_MARK } from '#common'

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

/**
 * Whether this mark is still offered when marking a work. Switching it off is as
 * close to deleting a mark as the list gets: the works keep it, and it goes on
 * hiding them and drawing its indicator, but it stops being one of the answers.
 * Stored as the absence of the flag rather than `disabled: false`, so a mark
 * nobody has touched stays the shape it shipped as.
 */
function offerModel(id: MarkId) {
  return computed({
    get: () => markIsOffered(marks.value, id),
    set: (v: boolean) => {
      const config = marks.value[id]
      if (!config)
        return
      if (v)
        delete config.disabled
      else
        config.disabled = true
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
    offer: offerModel(id),
    // A progress mark's hiding is a per-work decision (is there anything new to
    // read yet?), so the switch means something different enough to say so.
    hideLabel: markTracksProgress(marks.value, id) ? 'Hide until ready' : 'Hide in listings',
    hideAria: `Hide works marked ${label(id)} ${markTracksProgress(marks.value, id) ? 'until ready' : 'in listings'}`,
    offerAria: `Offer ${label(id)} when marking a work`,
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

// ---------------------------------------------------------------------------
// The edit dialog. One dialog for both jobs, because both are the same three
// fields — adding a mark is editing one that doesn't exist yet. Opened by a
// row's icon, by the pencil beside its name, or by the Add button, all of them
// detached triggers so focus comes back to whichever was pressed.
// ---------------------------------------------------------------------------

const dialog = ref<ComponentInstance<GlobalComponents['Dialog']> | null>(null)
const open = ref(false)

/** Vue hands a template ref back untyped; the detached triggers want the instance. */
function setDialogRef(instance: unknown) {
  dialog.value = instance as ComponentInstance<GlobalComponents['Dialog']>
}

/** The mark being edited, or null while adding one. */
const editing = ref<MarkId | null>(null)
const draftLabel = ref('')
const draftIcon = ref(DEFAULT_MARK_ICON)
const draftColor = ref('')

const creating = computed(() => editing.value === null)

/**
 * The key the mark lives under: worked out from the name while adding, fixed
 * once it exists. Every work id the mark holds is filed under it, so renaming a
 * mark moves the label and nothing else.
 */
const draftId = computed(() => editing.value ?? markIdFor(marks.value, draftLabel.value))

/**
 * Why this can't be saved yet. Adding runs the full check (blank, and a key
 * already taken); renaming only needs a name, since the key isn't moving and two
 * marks reading alike is odd rather than broken.
 */
const draftError = computed(() => {
  if (creating.value)
    return markNameError(marks.value, draftLabel.value)
  return draftLabel.value.trim() ? null : 'Give the mark a name.'
})

function edit(id: MarkId | null) {
  open.value = true
  editing.value = id
  const config = id ? marks.value[id] : undefined
  draftLabel.value = config?.label ?? ''
  draftIcon.value = config?.icon ?? DEFAULT_MARK_ICON
  // A mark with no colour of its own falls back to a muted default in CSS, and
  // the picker has no way to say "no colour" — so it opens on `read`'s, which is
  // what a new mark is given anyway.
  draftColor.value = config?.color || marks.value.read?.color || '#6b7280'
}

function save() {
  if (draftError.value)
    return
  const name = draftLabel.value.trim()

  if (creating.value) {
    const id = markIdFor(marks.value, name)
    const next = addMark(marks.value, name)
    // `addMark` builds the mark out of defaults; the dialog offered a look as
    // well as a name, so the two chosen fields go over the top of it before the
    // table is stored — one option write rather than two.
    next[id] = { ...next[id]!, icon: draftIcon.value, color: draftColor.value }
    marks.value = next
  }
  else {
    const config = marks.value[editing.value!]
    if (config) {
      config.label = name
      config.icon = draftIcon.value
      config.color = draftColor.value
    }
  }
  open.value = false
}
</script>

<template>
  <OptionRowCollapsable
    v-model:open="enabled"
    title="Work marks"
    subtitle="Mark a work read — or with a finer verdict, anything from Favorite to Abandoned — from its right-click menu. Pressing AO3's own “Mark as Read” marks it here too, so the list fills itself in as you browse."
  >
    <div flex="~ col gap-3" mt-2>
      <p text="sm muted-fg">
        A work carries one mark at a time: the finer verdicts all mean "read", so choosing one replaces whatever the
        work had. They take it off your Marked for Later list and — where "hide in listings" is on — collapse it out of
        results. An "always show" rule still wins.
      </p>

      <p text="sm muted-fg">
        "Ongoing" is the exception: it means you're waiting on more chapters, not that you're done. It keeps the work on
        Marked for Later and records the last chapter you finished, plus an optional date to wait until. With "hide
        until ready" on, the work is collapsed only while there's nothing new to read.
      </p>

      <p text="sm muted-fg">
        The arrows set the order marks appear in, here and in a work's menu. "Ongoing" stays last — it isn't one of the
        verdicts. Click a mark's icon, or the pencil beside its name, to rename it, recolour it or give it a different
        icon; hovering its name shows the key it is stored under, which never changes.
      </p>

      <p text="sm muted-fg">
        "In menus" is how a mark you have finished with gets out of the way: turn it off and it stops being offered
        when you mark a work, while every work already carrying it keeps it. Marks aren't deleted — the works filed
        under one would have nowhere to go.
      </p>

      <div flex="~ col gap-2" text="sm" border-t pt-3>
        <div grid="~ cols-[min-content_1fr_min-content_min-content_min-content]" items-center gap-x-4 gap-y-2>
          <span text="xs muted-fg uppercase tracking-wide" ws-nowrap>Order</span>
          <span text="xs muted-fg uppercase tracking-wide">Mark</span>
          <span text="xs muted-fg uppercase tracking-wide" ws-nowrap>Hide</span>
          <span text="xs muted-fg uppercase tracking-wide" ws-nowrap>In menus</span>
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
              <DialogDetachedTrigger
                v-if="dialog"
                class="input-ring"
                bg="hover:input"
                cursor-pointer rounded-md p-0.5
                :dialog="dialog"
                :title="`Change the ${row.label} icon`"
                @click="edit(row.id)"
              >
                <Icon
                  :class="row.icon"
                  :style="row.color ? { color: row.color } : undefined"
                  :label="`Change the ${row.label} icon`"
                />
              </DialogDetachedTrigger>
              <span flex="~ col gap-0.5">
                <span flex="~ items-center gap-1">
                  <span :title="`id: ${row.id}`">{{ row.label }}</span>
                  <DialogDetachedTrigger
                    v-if="dialog"
                    class="input-ring"
                    text="3.5 muted-fg hover:default-fg"
                    cursor-pointer rounded-md p-0.5
                    :dialog="dialog"
                    :title="`Rename ${row.label}`"
                    @click="edit(row.id)"
                  >
                    <Icon i-mdi-pencil :label="`Rename ${row.label}`" />
                  </DialogDetachedTrigger>
                </span>
                <span text="xs muted-fg">
                  {{ row.count.toLocaleString() }} {{ row.count === 1 ? 'work' : 'works' }}<template v-if="row.tracksProgress"> · stays on Marked for Later</template><template v-else-if="row.alias"> · counts as {{ label(row.alias) }}</template>
                </span>
              </span>
            </span>
            <Switch v-model="row.hide.value" :title="row.hideLabel" :aria-label="row.hideAria" />
            <Switch v-model="row.offer.value" title="Offer when marking a work" :aria-label="row.offerAria" />
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

        <div>
          <Button variant="outline" size="sm" @click="edit(null)">
            <Icon i-mdi-plus mr-1 />
            Add mark
          </Button>
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

    <Dialog :ref="setDialogRef" v-model:open="open" detached-trigger>
      <DialogContent>
        <DialogTitle>
          {{ creating ? 'Add mark' : 'Edit mark' }}
        </DialogTitle>
        <DialogDescription class="sr-only">
          Set the name a mark is shown under, the icon it is drawn with, and the colour of that icon.
        </DialogDescription>
        <div flex="~ col gap-4" pt-4>
          <label flex="~ col gap-1">
            <span text="sm muted-fg">Name</span>
            <Input
              v-model="draftLabel"
              type="text"
              name="mark-name"
              :aria-invalid="!!draftError"
              text="base" h-10 w-full py-2 pl-2
            />
            <p v-if="draftError" role="alert" text="xs destructive" pl-1>
              {{ draftError }}
            </p>
            <p v-else-if="creating" text="xs muted-fg" pl-1>
              Stored under the key <code>{{ draftId }}</code>, worked out from the name. That key never changes —
              every work you mark is filed under it — but the name above can be edited whenever you like.
            </p>
            <p v-else text="xs muted-fg" pl-1>
              Shown in menus, indicators and hide reasons. Stored under the key <code>{{ draftId }}</code>, which
              can't change.
            </p>
          </label>

          <div flex="~ col gap-1">
            <span text="sm muted-fg">Icon</span>
            <div flex="~ wrap gap-1" border="1 input" rounded-md p-2>
              <button
                v-for="name in MARK_ICON_NAMES"
                :key="name"
                type="button"
                class="input-ring"
                border="1 transparent"
                cursor-pointer rounded-md p-1.5
                :class="draftIcon === name ? 'border-primary bg-primary/20' : 'hover:bg-input'"
                :title="name"
                :aria-pressed="draftIcon === name"
                @click="draftIcon = name"
              >
                <Icon :class="markIconClassName(name)" text-4.5 :style="{ color: draftColor }" :label="name" />
              </button>
            </div>
          </div>

          <label flex="~ col gap-1">
            <span text="sm muted-fg">Color</span>
            <ColorInput v-model="draftColor">
              <span text="xs muted-fg">Used for this mark's indicator on a work.</span>
            </ColorInput>
          </label>

          <div flex="~ gap-4 justify-end">
            <Button
              text="sm"
              variant="outline"
              @click="open = false"
            >
              Cancel
            </Button>
            <Button
              text="sm"
              variant="default"
              :disabled="!!draftError"
              @click="save"
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </OptionRowCollapsable>
</template>
