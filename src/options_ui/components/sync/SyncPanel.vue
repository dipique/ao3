<script setup lang="ts">
import type { Severity } from '../../model/severity.ts'
import type { SyncAnswer, SyncCallout, SyncState } from '../../model/syncStatus.ts'

/**
 * The sync switch's row, heading a panel that reports on it: a chip naming the
 * state, when sync last succeeded, a callout for each thing wrong, and how full
 * the synced storage is. While sync is off with nothing to say, the panel is
 * the row alone. What it says is {@link file://../../model/syncStatus.ts}.
 *
 * A held update's callout is a question: what the update would remove, and
 * the two answers drawn alike, each with what it does, so that neither reads
 * as the one to pick.
 */
const { state, status, setEnabled, resolveHeld } = useSync()

/**
 * The states with a glyph of their own; the rest take their severity's. A
 * pause is no fault, so it doesn't take the warning triangle: a hold is a pause
 * waiting on the reader, a version pause lifts once this browser updates, and
 * older synced settings wait for a save. Off is an empty ring.
 */
const GLYPHS: Partial<Record<SyncState, string>> = {
  'off': 'i-tabler-circle-dashed',
  'held': 'i-mdi-pause-circle-outline',
  'newer-version': 'i-tabler-player-pause',
  'older-cloud': 'i-tabler-clock',
}

const CHIP_TONES = {
  destructive: 'border-destructive/45 bg-destructive/10',
  warning: 'border-warning/45 bg-warning/10',
  success: 'border-success/45 bg-success/10',
  neutral: 'border-muted-fg/45 bg-muted-fg/10',
} as const satisfies Record<Severity, string>

const FILLS = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
} as const

/** An error stands until the next sync, so it isn't announced as it appears; the rest are. */
function role(callout: SyncCallout): 'alert' | undefined {
  return callout.state === 'error' ? undefined : 'alert'
}

function consequenceId(answer: SyncAnswer): string {
  return `sync-answer-${answer.choice}`
}
</script>

<template>
  <section data-sync-panel aria-label="Sync settings across devices" class="sync-panel">
    <div class="sync-panel__head">
      <OptionRow
        title="Sync settings across devices"
        subtitle="Store your options in the browser's synced storage so they follow you to other browsers signed in to the same account. Cache is never synced."
      >
        <template #default="{ id }">
          <Switch :id="id" :model-value="state.enabled" @update:model-value="setEnabled" />
        </template>
      </OptionRow>
    </div>

    <div v-if="status.chip" class="sync-panel__body">
      <div class="sync-panel__status">
        <span :data-sync-chip="status.chip.state" :class="CHIP_TONES[status.chip.severity]" class="sync-chip">
          <SeverityGlyph :severity="status.chip.severity" :glyph="GLYPHS[status.chip.state]" wordless text-sm />
          {{ status.chip.word }}
        </span>
        <span v-if="status.chip.detail" data-sync-detail>{{ status.chip.detail }}</span>
        <span v-if="status.lastSynced" data-sync-last class="sync-panel__last">{{ status.lastSynced }}</span>
      </div>

      <Callout
        v-for="callout in status.callouts"
        :key="callout.state"
        :severity="callout.severity"
        :glyph="GLYPHS[callout.state]"
        :role="role(callout)"
        v-bind="callout.hook"
      >
        <div v-if="callout.decision" class="sync-held">
          <p font-700>
            {{ callout.text }}
          </p>
          <ul data-sync-losses class="sync-held__losses">
            <li v-for="line in callout.decision.lines" :key="line">
              {{ line }}
            </li>
          </ul>
          <p v-if="callout.decision.backup">
            {{ callout.decision.backup }}
          </p>
          <div class="sync-held__answers">
            <div
              v-for="answer in callout.decision.answers"
              :key="answer.choice"
              :data-sync-answer="answer.choice"
              class="sync-held__answer"
            >
              <button
                type="button"
                class="outline-btn"
                v-bind="{ [`data-sync-${answer.choice}`]: '' }"
                :aria-describedby="consequenceId(answer)"
                :disabled="state.resolving"
                @click="resolveHeld(answer.choice)"
              >
                {{ answer.label }}
              </button>
              <p :id="consequenceId(answer)" text="[11.5px] muted-fg" leading-4>
                {{ answer.consequence }}
              </p>
            </div>
          </div>
        </div>
        <p v-else>
          {{ callout.text }}
        </p>
      </Callout>

      <div v-if="status.usage" data-sync-usage class="sync-usage">
        <span text-muted-fg>Synced storage</span>
        <div
          role="progressbar"
          aria-label="Synced storage used"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="status.usage.pct"
          class="sync-usage__bar"
          h-2 overflow-hidden rounded-full bg-input
        >
          <div data-sync-usage-bar :class="FILLS[status.usage.level]" h-full rounded-full transition-all :style="{ width: `${status.usage.pct}%` }" />
        </div>
        <span inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums>
          <SeverityGlyph v-if="status.usage.level !== 'success'" :severity="status.usage.level" text-sm />
          {{ status.usage.usedKb }} of {{ status.usage.maxKb }} · {{ status.usage.pct }}%
        </span>
        <p v-if="status.usage.advice" data-sync-advice class="sync-usage__advice">
          <SeverityGlyph :severity="status.usage.level" mt-px shrink-0 text-sm />
          <span>{{ status.usage.advice }}</span>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
  The switch's row heads the panel, and what the panel reports sits under it on
  a recessed ground. Below 768 px the panel's padding shrinks with the page's.
*/
.sync-panel {
  overflow: hidden;
  border: 1px solid rgb(var(--color-border));
  border-radius: 12px;
  background-color: rgb(var(--color-default));
}
.sync-panel__head :deep(.option-row) {
  margin: 0;
  padding: 12px;
  border-top-width: 0;
  border-radius: 0;
}
.sync-panel__head :deep(.option-row:hover) {
  background-color: transparent;
}
.sync-panel__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid rgb(var(--color-hair));
  background-color: rgb(var(--color-sunken));
}
.sync-panel__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  font-size: 12.5px;
  line-height: 17px;
}
.sync-panel__last {
  width: 100%;
  color: rgb(var(--color-muted-fg));
  font-size: 11.5px;
  line-height: 16px;
}
/* On a phone the switch sits beside the title, and the description runs under both. */
@media (max-width: 767.98px) {
  .sync-panel__head :deep(.option-row__text) {
    display: contents;
  }
  .sync-panel__head :deep(.option-row__title) {
    flex: 1 1 0;
    min-width: 0;
  }
  .sync-panel__head :deep(.option-row__description) {
    flex-basis: 100%;
    order: 1;
  }
}
@media (min-width: 768px) {
  .sync-panel__head :deep(.option-row) {
    padding: 14px 16px 13px;
  }
  .sync-panel__body {
    padding: 13px 16px 14px;
  }
  .sync-panel__last {
    width: auto;
    margin-left: auto;
  }
}

.sync-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px 0 7px;
  border-width: 1px;
  border-style: solid;
  border-radius: 999px;
  color: rgb(var(--color-default-fg));
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

/*
  The losses are a list of their own, one per line, each marked with a minus in
  the hold's colour; the mark is decoration, so screen readers skip it where
  the browser lets them. The two answers sit side by side where there is room
  for both labels on one line, and stack where there isn't, as on a phone.
*/
.sync-held {
  display: flex;
  flex-direction: column;
  gap: 8px;
  container-type: inline-size;
}
.sync-held__losses {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 3px 22px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.sync-held__losses li {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.sync-held__losses li::before {
  content: '\2212';
  content: '\2212' / '';
  color: rgb(var(--color-warning));
  font-weight: 700;
}
.sync-held__answers {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}
.sync-held__answer {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
  padding: 10px 12px 11px;
  border: 1px solid rgb(var(--color-border));
  border-radius: 9px;
  background-color: rgb(var(--color-default));
}
.sync-held__answer button {
  justify-content: center;
}
@container (min-width: 520px) {
  .sync-held__losses,
  .sync-held__answers {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .sync-held__answer {
    align-items: flex-start;
  }
}

/*
  The bar between its label and its figure; below 768 px the label and figure
  share a line, and the bar goes under them. The advice is about the bar, so it
  sits under it.
*/
.sync-usage {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 10px;
  font-size: 12px;
}
.sync-usage__bar {
  grid-row: 2;
  grid-column: 1 / -1;
}
.sync-usage__advice {
  display: flex;
  grid-column: 1 / -1;
  align-items: flex-start;
  gap: 6px;
  font-size: 11.5px;
  line-height: 15px;
}
@media (min-width: 768px) {
  .sync-usage {
    grid-template-columns: 112px minmax(0, 1fr) auto;
    gap: 14px;
  }
  .sync-usage__bar {
    grid-row: auto;
    grid-column: auto;
  }
  .sync-usage__advice {
    grid-column: 2 / -1;
    margin-top: -6px;
  }
}
</style>
