// What became of a fix drafted from /savings: kept when "Draft the fix" is pressed, read against each
// later run. A draft changes nothing by itself, and the date a change lands is not known, so until a run
// sees a change the line says none has been seen, and spend after it is read only from the first run that
// saw a new size or type, once a whole window of billing lies after it. The before and after amounts are
// billed in different weeks, so a change in workload moves them too: the line shows them as observed spend
// and never calls the difference saved. A fix that changes neither leaves nothing to see but its finding
// clearing, which usage falling can do too.
import type { SavingsFinding, SavingsFixLine, SavingsPlatform, SavingsView, WarehouseConfig } from '../types'
import { changedSettings, comparable, configLabel, configOf, learns, loadConfig, mergeConfig, SETTINGS, settingsNoun } from './savings-config'
import { cents, DAY_MS, OBSERVED_NOTE, oneLine, PLATFORM_NAME, windowDays } from './savings-format'

/** What is kept when a fix is drafted. */
export type FixRecord = {
  /** The day it was drafted (YYYY-MM-DD, UTC). */
  date: string
  platform: SavingsPlatform
  /** The check whose finding was drafted from. */
  checkId?: string
  resourceType: string
  resourceId: string
  workspaceId: string | null
  resourceName: string
  title: string
  /**
   * The warehouse's settings when the fix was drafted, each as read or null, when the fix is a change of them; null
   * for any other fix. One kept by an older version as a string loads with every setting unknown.
   */
  config: WarehouseConfig | null
  /** What it cost a day then, from billing; null when that was not known. */
  dailyCost: number | null
  /** How that cost was priced: a later run priced differently cannot be compared with it. */
  pricing?: string
  /** The day a run first saw the change; absent until one has. */
  changedSeen?: string
}

export const FIX_PREFIX = 'savings-fix:'

// The checks whose fix shows up as a new warehouse size or type. Any other fix (auto-suspend, a lower
// cluster maximum) changes a setting the answers do not carry.
const SIZING_CHECKS = new Set(['wh_classic_pro_to_serverless', 'wh_oversized', 'downsize_warehouse'])

/** The settings to compare later runs against, for a fix that changes them; null for any other fix. */
export const fixConfig = (one: Pick<SavingsFinding, 'checkId' | 'config'>): WarehouseConfig | null =>
  SIZING_CHECKS.has(one.checkId) && one.config != null ? loadConfig(one.config) : null

/** A kept fix's settings as this version reads them. */
const keptConfig = (fix: FixRecord): WarehouseConfig | null => (fix.config === null || fix.config === undefined ? null : loadConfig(fix.config))

export const fixKey = (connection: string, one: Pick<SavingsFinding, 'resourceType' | 'resourceId'> & { workspaceId?: string | null }) =>
  `${FIX_PREFIX}${connection}:${one.workspaceId ?? ''}:${one.resourceType}:${one.resourceId}`

export function isFixRecord(value: unknown): value is FixRecord {
  const one = value as FixRecord | null
  return !!one && typeof one === 'object' && typeof one.date === 'string' && typeof one.resourceId === 'string' && typeof one.resourceName === 'string'
}

/** The window's days that lie wholly after `date`. */
export function daysAfter(date: string, window: { start: string; end: string }): number {
  const firstAfter = Date.parse(date) + DAY_MS
  const start = Math.max(Date.parse(window.start), firstAfter)
  const days = Math.round((Date.parse(window.end) - start) / DAY_MS)
  return Number.isFinite(days) ? Math.min(Math.max(days, 0), windowDays(window)) : 0
}

const severalWorkspaces = (view: SavingsView) => (view.checked?.workspaces ?? 1) > 1
/**
 * Whether a warehouse row is in the workspace a fix or finding names. An id repeats across workspaces: with several
 * read, the two must name the same one (an answer kept without row workspaces matches none). With one read, a side
 * that names no workspace matches, but two that name different ones never do: a later run that reads only the other
 * workspace is not the fix's warehouse.
 */
export const sameWorkspace = (row: string | null | undefined, wanted: string | null | undefined, several: boolean) =>
  several ? (row ?? null) === (wanted ?? null) : !row || !wanted || row === wanted
// Snowflake gives a warehouse with no usage its name for an id, so there the name finds it too.
const rowOf = (fix: FixRecord, view: SavingsView) =>
  view.inventory.find(
    one =>
      (one.id === fix.resourceId || (fix.platform === 'snowflake' && one.name === fix.resourceName)) &&
      sameWorkspace(one.workspaceId, fix.workspaceId, severalWorkspaces(view)),
  )
const isFlagged = (fix: FixRecord, view: SavingsView, sameCheck: boolean) =>
  view.findings.some(
    one =>
      (one.resourceId === fix.resourceId || (fix.platform === 'snowflake' && one.resourceName === fix.resourceName)) &&
      one.resourceType === fix.resourceType &&
      (one.workspaceId ?? null) === (fix.workspaceId ?? null) &&
      (!sameCheck || !fix.checkId || one.checkId === fix.checkId),
  )

/** Whether the check behind the fix did not read everything this time: its finding being absent then says nothing. */
const checkPartial = (fix: FixRecord, view: SavingsView) => view.limited.length > 0 || view.skipped.some(one => one.includes(fix.title))

/**
 * Whether this run shows the fix landed: a new size or type, or, for any other fix on a listed warehouse,
 * its finding gone. Null when the run cannot tell: the warehouse is not listed, or the check did not run.
 */
export function fixChanged(fix: FixRecord, view: SavingsView): boolean | null {
  const row = rowOf(fix, view)
  if (!row) return null
  const was = keptConfig(fix)
  if (was !== null) {
    const now = configOf(row)
    // Only a setting known both when it was drafted and now can show a change; with none, this run cannot tell.
    return comparable(was, now).length === 0 ? null : changedSettings(was, now).length > 0
  }
  return checkPartial(fix, view) ? null : !isFlagged(fix, view, true)
}

/**
 * The settings a kept fix holds after this run: each one it did not know is filled from what this run read, and
 * none it knew is overwritten. Null when the run teaches it nothing.
 */
export function mergedConfig(fix: FixRecord, view: SavingsView): WarehouseConfig | null {
  const was = keptConfig(fix)
  const row = was === null ? undefined : rowOf(fix, view)
  if (!was || !row) return null
  const now = configOf(row)
  return learns(was, now) ? mergeConfig(was, now) : null
}

/** What a run says became of a drafted fix. */
export function fixProgress(fix: FixRecord, view: SavingsView): SavingsFixLine {
  const line = (state: SavingsFixLine['state'], text: string): SavingsFixLine => ({
    resourceType: fix.resourceType,
    resourceId: fix.resourceId,
    workspaceId: fix.workspaceId ?? null,
    resourceName: fix.resourceName,
    state,
    // Names repeat across workspaces, so with several read the line names its own.
    text: `${fix.resourceName}${severalWorkspaces(view) && fix.workspaceId ? ` (workspace ${oneLine(fix.workspaceId)})` : ''}: ${text}`,
  })
  const was = keptConfig(fix)
  const flagged = isFlagged(fix, view, was === null)
  const drafted = `fix drafted ${fix.date}`
  const days = windowDays(view.window)
  const billing = `measured from ${PLATFORM_NAME[fix.platform]} billing`
  const row = rowOf(fix, view)
  // While the window still reaches back before the draft, it is too early to say the fix did nothing.
  const sinceDraft = daysAfter(fix.date, view.window)
  const notRun = line('unmeasured', `${drafted}, but its check did not run in full this time, so nothing is claimed.`)
  const waiting = (still: string) => line('measuring', `${drafted} · measuring (${sinceDraft} of ${days} days): ${still}, no change seen yet`)

  // A cluster or job is in a run's answer only while it is flagged, so its cost afterwards is not known.
  if (!row) {
    if (was !== null) return line('unmeasured', `${drafted}, and this run did not list it, so no amount is claimed.`)
    if (flagged) return sinceDraft < days ? waiting('still flagged') : line('unchanged', `${drafted}, and it is still flagged, so no saving is claimed.`)
    if (checkPartial(fix, view)) return notRun
    return line('unmeasured', `${drafted}, and it is no longer flagged. This check does not read its cost afterwards, so no amount is claimed.`)
  }
  // A line names only the settings known both when the fix was drafted and now: the only ones it compared.
  const named = was === null ? [] : comparable(was, configOf(row))
  if (was !== null && named.length === 0) {
    return line('unmeasured', `${drafted}, but its ${settingsNoun(SETTINGS)} were not read both then and now, so nothing is claimed yet.`)
  }
  const config = configLabel(configOf(row), named)
  const changed = fixChanged(fix, view)
  if (changed === null) return notRun
  if (!changed) {
    if (sinceDraft < days && (flagged || was === null)) return waiting(was === null ? 'still flagged' : `still ${config}`)
    if (was === null) return line('unchanged', `${drafted}, and it is still flagged, so no saving is claimed.`)
    return flagged
      ? line('unchanged', `${drafted}, but it is still ${config} and still flagged, so no saving is claimed.`)
      : line('unchanged', `${drafted}, but it is still ${config}: it is no longer flagged, and its ${settingsNoun(named)} did not change, so no saving is claimed.`)
  }
  // Counted from the first run that saw the change: the change itself may have landed any time before it.
  const since = fix.changedSeen ?? view.window.end
  const after = daysAfter(since, view.window)
  if (after < days) return line('measuring', `${drafted} · measuring (${after} of ${days} days)`)
  const what = was !== null ? `changed to ${config}` : 'no longer flagged'
  if (fix.dailyCost === null || row.windowCost === null) return line('unmeasured', `${what} since ${since}, but its cost was not known on both sides, so no amount is claimed.`)
  if (fix.pricing && fix.pricing !== view.pricing) return line('unmeasured', `${what} since ${since}, but its cost was priced differently then, so no amount is claimed.`)
  const dailyNow = row.windowCost / days
  const costs = `${cents(fix.dailyCost)} a day before, ${cents(dailyNow)} a day now (${billing})`
  // Usage falling clears a finding too, and this fix leaves no setting in the answer to tell the two apart.
  if (was === null) return line('no_saving', `${what} since ${since}: ${costs}. The answer does not show whether your change did that, so no saving is claimed.`)
  const gap = fix.dailyCost - dailyNow
  if (gap <= 0) return line('no_saving', `${what} since ${since}, but its cost did not fall: ${costs}.`)
  return line('lower', `${what} since ${since}: observed spend ${costs}. ${OBSERVED_NOTE}`)
}
