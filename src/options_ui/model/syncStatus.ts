import type { SyncUsage } from '../../common/api.ts'
import type { Inconsistency } from '../../common/syncConsistency.ts'
import type { SyncPause } from '../../common/syncMeta.ts'
import type { Severity } from './severity.ts'

import { SYNC_CONSISTENCY_WAIT_MS } from '../../common/constants.ts'
import { pullLossParts } from '../../common/syncGuard.ts'
import { HELD_BACKUP_NOTE, staleBackgroundMessage, versionPauseReason } from '../../common/syncMessages.ts'
import { formatMoment } from './moments.ts'
import { sentence } from './phrases.ts'
import { SEVERITIES } from './severity.ts'

/**
 * What the sync panel shows, from the engine's state as the options page reads
 * it. The switch heads the panel. Below it, a chip names the state, callouts
 * say what is wrong and what to do about it, and a bar shows how full the
 * synced storage is.
 *
 * States stack: a stale background, an error and a pause can all hold at once.
 * The chip names the most severe, and the callouts follow in severity order.
 * The bar's level is its own, and never moves the chip.
 */

export interface SyncStatusInput {
  enabled: boolean
  pause?: SyncPause | null
  /** A push or read that failed and will be retried. */
  lastError?: string
  /** When sync last succeeded, in milliseconds since the epoch; 0 for never. */
  lastSyncAt?: number
  /** The background found itself running older code than the build on disk, and stopped syncing. */
  staleBuild: boolean
  /** The background didn't answer as this page's build, so it may be running older code. */
  backgroundOutdated: boolean
  /** Why turning sync on was just refused. */
  refusal?: string
  usage?: SyncUsage | null
  /** The synced copy as the background last read it, where it couldn't be read whole. */
  inconsistent?: Inconsistency | null
}

/** What a chip or a callout is about, which also picks its glyph. A refusal's chip is `off`. */
export type SyncState = 'off' | 'syncing' | 'stale' | 'error' | 'refusal' | 'inconsistent' | SyncPause['reason']

export interface SyncChip {
  state: SyncState
  word: string
  /** A sentence beside the word, for a state the word alone doesn't explain. */
  detail?: string
  severity: Severity
}

export interface SyncAnswer {
  /** `replace`: the offer to replace synced settings that can't be read whole. */
  choice: 'keep' | 'accept' | 'replace'
  label: string
  /** What the answer does, shown beside it: the two weigh the same. */
  consequence: string
}

/** A held update's question: what it would remove, one line each, and the two answers; or the offer to replace synced settings that can't be read whole. */
export interface SyncDecision {
  lines: string[]
  /** That this browser's settings are backed up, as they were when sync asked; null when they weren't. */
  backup: string | null
  answers: SyncAnswer[]
}

export interface SyncCallout {
  state: SyncState
  severity: Severity
  text: string
  /** The callout's `data-sync-*` test hook, as attributes. */
  hook: Readonly<Record<string, string>>
  /** On a held update's callout, under its text. */
  decision?: SyncDecision
}

export interface SyncUsageView {
  usedKb: string
  maxKb: string
  pct: number
  level: 'success' | 'warning' | 'destructive'
  /** Under the bar, once it is nearly full. */
  advice?: string
}

export interface SyncStatusView {
  /** Absent while sync is off with nothing to say: the panel is then the switch alone. */
  chip?: SyncChip
  /** When sync last succeeded. Absent while sync is off, and while an error stands in its place. */
  lastSynced?: string
  callouts: SyncCallout[]
  /** Absent while sync is off, or until the usage is known. */
  usage?: SyncUsageView
}

/** From this share of the synced storage, the bar turns `warning`… */
const USAGE_WARNING_PCT = 70
/** …and from this one `destructive`, with advice. */
const USAGE_FULL_PCT = 90

const SYNCING: SyncChip = { state: 'syncing', word: 'Syncing', severity: 'success' }
const OFF: SyncChip = { state: 'off', word: 'Off', severity: 'neutral' }

/** The sync panel for `input`, in the words of a build at sync version `version`. */
export function syncStatusView(input: SyncStatusInput, version: number): SyncStatusView {
  const states = bySeverity(statesOf(input, version))
  const callouts = states.map(state => state.callout)
  if (!input.enabled)
    return callouts.length ? { chip: OFF, callouts } : { callouts }

  const view: SyncStatusView = { chip: states[0]?.chip ?? SYNCING, callouts }
  if (!input.lastError)
    view.lastSynced = lastSynced(input.lastSyncAt ?? 0)
  if (input.usage)
    view.usage = usageView(input.usage)
  return view
}

interface State { chip: SyncChip, callout: SyncCallout }

/**
 * Every state that holds, in the order states of one severity are shown. While
 * sync is off only what bears on turning it on is said: an error or a pause
 * from while it was on no longer applies.
 */
function statesOf(input: SyncStatusInput, version: number): State[] {
  const states: State[] = []
  if (input.staleBuild || input.backgroundOutdated) {
    states.push({
      chip: { state: 'stale', word: 'Reload needed', severity: 'destructive' },
      callout: { state: 'stale', severity: 'destructive', text: staleBackgroundMessage(input.staleBuild), hook: { 'data-sync-stale': '' } },
    })
  }
  if (!input.enabled) {
    if (input.refusal)
      states.push({ chip: OFF, callout: { state: 'refusal', severity: 'destructive', text: input.refusal, hook: { 'data-sync-refusal': '' } } })
    return states
  }
  if (input.inconsistent?.overdue)
    states.push(inconsistentState(input.inconsistent))
  if (input.lastError) {
    states.push({
      chip: { state: 'error', word: 'Couldn\'t sync', detail: 'It will be tried again.', severity: 'destructive' },
      callout: { state: 'error', severity: 'destructive', text: input.lastError, hook: { 'data-sync-error': '' } },
    })
  }
  if (input.pause)
    states.push(pauseState(input.pause, version))
  return states
}

function pauseState(pause: SyncPause, version: number): State {
  const state = pause.reason
  const hook = { 'data-sync-pause': state }
  switch (pause.reason) {
    case 'held':
      return {
        chip: { state, word: 'On hold', detail: 'An update from another browser is waiting for your answer.', severity: 'warning' },
        callout: { state, severity: 'warning', text: 'An update from another browser would remove:', hook, decision: heldDecision(pause) },
      }
    case 'first-sync': {
      const differ = 'Your synced settings differ from this browser\'s.'
      const detail = pause.otherCopy ? 'Settings from another browser are waiting for your answer.' : 'Turning on sync is waiting for your answer.'
      return {
        chip: { state, word: 'On hold', detail, severity: 'warning' },
        callout: { state, severity: 'warning', text: pause.loss ? `${differ} Using them would remove:` : `${differ} Which do you want to keep?`, hook, decision: firstSyncDecision(pause) },
      }
    }
    case 'newer-version':
      return {
        chip: { state, word: 'Paused', detail: 'This browser is older than your synced settings. It lifts by itself once updated.', severity: 'warning' },
        callout: { state, severity: 'warning', text: sentence(versionPauseReason(pause, version)), hook },
      }
    case 'older-cloud':
      return {
        chip: { state, word: 'Waiting', detail: 'Your synced settings are older than this browser.', severity: 'warning' },
        callout: { state, severity: 'warning', text: sentence(versionPauseReason(pause, version)), hook },
      }
  }
}

/**
 * Synced settings that still can't be read whole past the wait: no other
 * browser is taken to be sending the rest. Where this browser's own settings
 * can replace them (`replaceable`), it offers to, under a new ID, which every
 * other browser weighs as a copy another browser started.
 */
function inconsistentState(record: Inconsistency): State {
  const state = 'inconsistent'
  const minutes = Math.round(SYNC_CONSISTENCY_WAIT_MS / 60_000)
  const callout: SyncCallout = {
    state,
    severity: 'destructive',
    text: `Your synced settings are inconsistent: part of them is missing or doesn't match the rest, and nothing has arrived to complete them in ${minutes} minutes. Changes you make here won't sync until they're whole again.`,
    hook: { 'data-sync-inconsistent': '' },
  }
  if (record.replaceable) {
    callout.decision = {
      lines: [],
      backup: null,
      answers: [{ choice: 'replace', label: 'Replace them with this browser\'s settings', consequence: 'Makes this browser\'s settings your synced settings. Your other browsers ask before using them wherever their own settings differ, and back theirs up first.' }],
    }
  }
  return { chip: { state, word: 'Inconsistent', detail: 'Your synced settings can\'t be read whole.', severity: 'destructive' }, callout }
}

/**
 * Keeping this browser's settings always backs up the update first. Accepting
 * the update says this browser's settings are backed up, as they were when it
 * was held, or that its backup failed. A hold an older build recorded with
 * daily backups off has no backup either, and accepting says nothing of it:
 * it backs them up as it applies.
 *
 * In the present tense, since a backup that would repeat the newest of its
 * kind isn't written, and that one, taken earlier, holds them.
 */
function heldDecision(pause: Extract<SyncPause, { reason: 'held' }>): SyncDecision {
  const replaces = 'Replaces this browser\'s settings with the other browser\'s.'
  const yours = pause.backedUp ? ' Yours are backed up.' : pause.backupFailed ? ' Yours aren\'t backed up: the backup couldn\'t be saved.' : ''
  return {
    lines: pullLossParts(pause.loss),
    backup: pause.backedUp ? HELD_BACKUP_NOTE : null,
    answers: [
      { choice: 'keep', label: 'Keep this browser\'s settings', consequence: 'Sends this browser\'s settings to your other browsers. What the update had is kept as a backup first.' },
      { choice: 'accept', label: 'Accept the update', consequence: `${replaces}${yours}` },
    ],
  }
}

/**
 * Synced settings that differ from this browser's, as sync turns on or from
 * a copy another browser started, ask which to keep, as a held update does.
 * Keeping this browser's backs the synced settings up first. Using the synced
 * settings says this browser's are backed up, as they were when it asked, or
 * that the backup couldn't be saved.
 */
function firstSyncDecision(pause: Extract<SyncPause, { reason: 'first-sync' }>): SyncDecision {
  const yours = pause.backedUp ? 'Yours are backed up.' : 'Yours aren\'t backed up: the backup couldn\'t be saved.'
  return {
    lines: pause.loss ? pullLossParts(pause.loss) : [],
    backup: pause.backedUp ? HELD_BACKUP_NOTE : null,
    answers: [
      { choice: 'keep', label: 'Keep this browser\'s settings', consequence: 'Replaces your synced settings with this browser\'s, on every browser that syncs. The synced settings are kept as a backup first.' },
      { choice: 'accept', label: 'Use the synced settings', consequence: `Replaces this browser's settings with your synced settings. ${yours}` },
    ],
  }
}

/** Stable, so states of one severity keep the order they were found in. */
function bySeverity(states: State[]): State[] {
  return states.sort((a, b) => SEVERITIES.indexOf(a.callout.severity) - SEVERITIES.indexOf(b.callout.severity))
}

function lastSynced(at: number): string {
  return at ? `Last synced ${formatMoment(at)}` : 'Not synced yet'
}

/**
 * The bar measures the room left for settings: the format's fixed overhead is
 * taken out of both figures. Its level follows the percentage it shows, so the
 * colour never disagrees with the figure beside it.
 */
function usageView(usage: SyncUsage): SyncUsageView {
  const max = Math.max(1, usage.quota - usage.overheadBytes)
  const used = Math.max(0, usage.used - usage.overheadBytes)
  const pct = Math.min(100, Math.round((used / max) * 100))
  const view: SyncUsageView = {
    usedKb: kb(used),
    maxKb: kb(max),
    pct,
    level: pct >= USAGE_FULL_PCT ? 'destructive' : pct >= USAGE_WARNING_PCT ? 'warning' : 'success',
  }
  if (pct >= USAGE_FULL_PCT)
    view.advice = 'You\'re close to the sync storage limit. Reduce large filter lists or text replacements.'
  return view
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}
