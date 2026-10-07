<script setup lang="ts">
import type { ComponentInstance, GlobalComponents } from 'vue'

import type { HideMode, MarkId } from '#common'

import { addMark, countIds, DEFAULT_MARK_HIDE_MODE, DEFAULT_MARK_HIDE_PRIORITY, DEFAULT_MARK_ICON, listedMarkIds, MARK_ICON_NAMES, markedWorkCount, markHidesResults, markIconClassName, markIdFor, markIsLocal, markIsOffered, markNameError, markRoot, markTracksProgress, MAX_PRIORITY, MIN_PRIORITY, moveMark, reorderableMarkIds, SAVED_MARK } from '#common'

import type { MarkSort } from '../../model/listView.ts'

import { markIconClass } from '../../markIcons.ts'
import { MARK_ORDER_OFF, MARK_SORTS, markOrderOff, sortMarks } from '../../model/listView.ts'

const { enabled, marks, hideMode, hidePriority } = useOption('workMarks')

/**
 * The two settings that apply to every mark that hides, rather than to one:
 * *how* a marked work leaves a listing, and how strongly that beats the rules.
 *
 * Both are optional on the stored option — a table written before they existed
 * has neither — and `toRefs` carries that optionality onto the refs. This page
 * reads from a clone of the defaults, where both are always present, so the
 * refs are there; a value that isn't still falls back to the shipped default,
 * which is what a table synced in from an older build hands over.
 */
const mode = computed({
  get: () => hideMode!.value ?? DEFAULT_MARK_HIDE_MODE,
  set: (v: HideMode) => { hideMode!.value = v },
})

/**
 * Kept inside the rule scale on the way in, so a typed-over or emptied box
 * can't store a priority no contest would honour. An empty number input hands
 * back `null`, which reads as the default rather than as zero — zero is the one
 * value that would silently switch mark-hiding off against every rule.
 */
const priority = computed({
  get: () => hidePriority!.value ?? DEFAULT_MARK_HIDE_PRIORITY,
  set: (v: number | null) => {
    hidePriority!.value = typeof v === 'number' && Number.isFinite(v)
      ? Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.trunc(v)))
      : DEFAULT_MARK_HIDE_PRIORITY
  },
})

/** The marks that hold their own work ids, in the reader's order. */
const local = computed(() => listedMarkIds(marks.value))

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
 * How the list is shown. It lasts for this visit and is never stored: the
 * order the reader keeps is `order` on the marks, which only the order
 * buttons write, and those are inert under any other sort.
 */
const sort = ref<MarkSort>('order')
const shown = computed(() => sortMarks(rows.value, sort.value))
const orderOff = computed(() => markOrderOff(sort.value))
const orderOffId = useId()

const header = computed(() => {
  const works = markedWorkCount(marks.value)
  return `${rows.value.length} · ${works.toLocaleString()} ${works === 1 ? 'work' : 'works'}`
})

/**
 * Each row is the mark's order buttons, or its pin; its icon; its name with
 * the pencil; its count, in a column of its own so the counts line up; then
 * its Hide and In menus toggles and Clear. In a narrow frame the count goes
 * under the name, as wide as the row leaves it.
 */
const ROW = '"order icon identity meta actions" / 48px 24px minmax(6rem, 1fr) minmax(0, 13rem) auto'
const NARROW_ROW = '"order icon identity actions" "order icon meta meta" / 48px 24px minmax(0, 1fr) auto'

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

/**
 * Clearing can't be taken back (a daily backup may still have the marks), so
 * the button asks again in its own place: the first press arms it, the second
 * clears.
 */
const confirm = useConfirmInPlace()
const clearId = (id: MarkId) => `work-marks-clear:${id}`

function clear(id: MarkId) {
  const config = marks.value[id]
  if (!count(id) || !config || !confirm.press(clearId(id)))
    return
  config.items = ''
  // The payload is keyed by the ids just dropped, so it has to go with them —
  // otherwise every entry is orphaned, unreachable, and still costs quota.
  if (typeof config.progress === 'string')
    config.progress = ''
}

// ---------------------------------------------------------------------------
// The edit dialog. One dialog for both jobs, because both are the same three
// fields — adding a mark is editing one that doesn't exist yet. Opened by a
// row's icon or the pencil beside its name, both detached triggers, or by the
// frame's Add, and focus comes back to whichever was pressed.
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

/**
 * Add, from the frame's header. The dialog gives focus back to whatever had it
 * when it opened, so the button takes focus first, as a click doesn't make it
 * do in every browser.
 */
function add(event: MouseEvent) {
  (event.currentTarget as HTMLElement).focus()
  edit(null)
}

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
      <p text="[12.5px] muted-fg" leading="[18px]">
        A work carries one mark at a time: the finer verdicts all mean "read", so choosing one replaces whatever the
        work had. They take it off your Marked for Later list and — where "hide in listings" is on — take it out of
        results the way the two settings below say.
      </p>

      <p text="[12.5px] muted-fg" leading="[18px]">
        "Ongoing" is the exception: it means you're waiting on more chapters, not that you're done. It keeps the work on
        Marked for Later and records the last chapter you finished, plus an optional date to wait until. With "hide
        until ready" on, the work is collapsed only while there's nothing new to read.
      </p>

      <p text="[12.5px] muted-fg" leading="[18px]">
        The arrows set the order marks appear in, here and in a work's menu. "Ongoing" stays last — it isn't one of the
        verdicts. Click a mark's icon, or the pencil beside its name, to rename it, recolour it or give it a different
        icon; hovering its name shows the key it is stored under, which never changes.
      </p>

      <p text="[12.5px] muted-fg" leading="[18px]">
        "In menus" is how a mark you have finished with gets out of the way: turn it off and it stops being offered
        when you mark a work, while every work already carrying it keeps it. Marks aren't deleted — the works filed
        under one would have nowhere to go.
      </p>

      <div flex="~ col gap-4 sm:row" border-t pt-3>
        <label flex="~ col gap-1" grow>
          <span text="[12.5px] muted-fg" leading="[18px]">When a mark hides a work</span>
          <Select v-model="mode" size="row" w-full>
            <SelectItem value="collapse">
              Collapse it to a line saying which mark hid it
            </SelectItem>
            <SelectItem value="hide">
              Take it out of the listing completely
            </SelectItem>
          </Select>
          <p v-if="mode === 'collapse'" text="[11.5px] muted-fg" leading="[16px]">
            The work keeps its place, squeezed down to its mark and a button to show it — and keeps its slot in a
            custom search view's results.
          </p>
          <p v-else text="[11.5px] muted-fg" leading="[16px]">
            The work is gone. In a custom search view it is dropped from the results altogether, so a page still fills
            with the number of works you asked for.
          </p>
        </label>

        <label flex="~ col gap-1" w="full sm:40">
          <span text="[12.5px] muted-fg" leading="[18px]">Priority</span>
          <Input
            v-model.number="priority"
            type="number"
            :min="MIN_PRIORITY"
            :max="MAX_PRIORITY"
            class="h-[26px] w-full rounded-[7px] px-2 text-[12.5px] tabular-nums"
          />
          <p text="[11.5px] muted-fg" leading="[16px]">
            {{ MIN_PRIORITY }}–{{ MAX_PRIORITY }}, vs. rule priorities
          </p>
        </label>
      </div>

      <ListFrame
        list-id="work-marks"
        title="Work marks"
        :count="header"
        add-label="Add mark"
        @add="add"
      >
        <template #controls>
          <ListSort v-model="sort" :choices="MARK_SORTS" />
        </template>

        <ListRow
          v-for="row in shown"
          :key="row.id"
          :row-id="row.id"
          :template="ROW"
          :narrow-template="NARROW_ROW"
        >
          <template #order>
            <template v-if="row.movable">
              <button
                type="button"
                class="icon-btn"
                :aria-label="`Move ${row.label} up`"
                :title="orderOff ?? `Move ${row.label} up`"
                :aria-describedby="orderOff ? orderOffId : undefined"
                :disabled="!!orderOff || !row.canMoveUp"
                @click="move(row.id, -1)"
              >
                <span class="i-tabler-chevron-up" text="[15px]" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="icon-btn"
                :aria-label="`Move ${row.label} down`"
                :title="orderOff ?? `Move ${row.label} down`"
                :aria-describedby="orderOff ? orderOffId : undefined"
                :disabled="!!orderOff || !row.canMoveDown"
                @click="move(row.id, 1)"
              >
                <span class="i-tabler-chevron-down" text="[15px]" aria-hidden="true" />
              </button>
            </template>
            <span
              v-else
              class="grid size-6 place-items-center"
              :title="`${row.label} always comes last — it isn't one of the read verdicts`"
            >
              <Icon i-tabler-pin text="[13px]" :label="`${row.label} is always last`" />
            </span>
          </template>
          <template #icon>
            <DialogDetachedTrigger
              v-if="dialog"
              class="icon-btn"
              :dialog="dialog"
              :title="`Change the ${row.label} icon`"
              @click="edit(row.id)"
            >
              <Icon
                :class="row.icon"
                text="[15px]"
                :style="row.color ? { color: row.color } : undefined"
                :label="`Change the ${row.label} icon`"
              />
            </DialogDetachedTrigger>
          </template>
          <span class="min-w-0 flex items-center gap-1">
            <span class="truncate" :title="`id: ${row.id}`">{{ row.label }}</span>
            <DialogDetachedTrigger
              v-if="dialog"
              class="icon-btn"
              :dialog="dialog"
              :title="`Rename ${row.label}`"
              @click="edit(row.id)"
            >
              <Icon i-tabler-pencil text="[13px]" :label="`Rename ${row.label}`" />
            </DialogDetachedTrigger>
          </span>
          <template #meta>
            {{ row.count.toLocaleString() }} {{ row.count === 1 ? 'work' : 'works' }}<template v-if="row.tracksProgress">
              · stays on Marked for Later
            </template><template v-else-if="row.alias">
              · counts as {{ label(row.alias) }}
            </template>
          </template>
          <template #actions>
            <div class="flex items-center gap-[2px]">
              <IconToggle v-model="row.hide.value" :label="row.hideAria" :tip="row.hideLabel" icon="i-tabler-eye-off" />
              <IconToggle v-model="row.offer.value" :label="row.offerAria" tip="In menus" icon="i-tabler-menu-2" />
              <!-- One button, armed or not, so a press from the keyboard keeps its focus. -->
              <button
                type="button"
                :class="confirm.armed(clearId(row.id))
                  ? 'destructive input-ring ml-[2px] h-6 cursor-pointer whitespace-nowrap rounded-md px-2 text-[11.5px] font-600'
                  : 'icon-btn'"
                :aria-label="confirm.armed(clearId(row.id)) ? undefined : `Clear ${row.label} marks`"
                :title="confirm.armed(clearId(row.id))
                  ? `Clear all ${row.count.toLocaleString()} “${row.label}” marks? This can't be undone (a daily backup may still have them).`
                  : `Clear ${row.label} marks`"
                :disabled="row.count === 0"
                @click="clear(row.id)"
              >
                <template v-if="confirm.armed(clearId(row.id))">
                  Clear {{ row.count.toLocaleString() }}?
                </template>
                <span v-else class="i-tabler-trash" text="sm" aria-hidden="true" />
              </button>
            </div>
          </template>
        </ListRow>
      </ListFrame>
      <span :id="orderOffId" hidden>{{ MARK_ORDER_OFF }}</span>

      <p v-if="external.length" text="[11.5px] muted-fg" leading="[16px]">
        <template v-for="id in external" :key="id">
          <Icon :class="markIconClass(marks[id]?.icon)" />
          {{ label(id) }}<span v-if="id === SAVED_MARK"> lives on AO3, not here — this entry only says how it is drawn on results.</span>
        </template>
      </p>

      <p text="[11.5px] muted-fg" leading="[16px]">
        Marks are stored with your settings, so they're included in backups and sync.
        <template v-if="showSize">
          They currently take about {{ packedKb.toFixed(1) }}&nbsp;KB (compressed further before syncing, which has a
          100&nbsp;KB budget for all settings combined).
        </template>
      </p>
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
