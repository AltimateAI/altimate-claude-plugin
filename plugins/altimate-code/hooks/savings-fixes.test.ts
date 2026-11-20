import { expect, test } from 'claude-code/testing'

import type { SavingsFinding, SavingsView } from '../types'
import type { WarehouseConfig } from '../types'
import { OBSERVED_NOTE } from './savings-format'
import { daysAfter, fixChanged, fixConfig, fixKey, fixProgress, isFixRecord, mergedConfig, type FixRecord } from './savings-fixes'

const WINDOW = { start: '2026-11-11', end: '2026-11-18' }

const fix = (over: Partial<FixRecord> = {}): FixRecord => ({
  date: '2026-11-01',
  platform: 'databricks',
  checkId: 'wh_oversized',
  resourceType: 'sql_warehouse',
  resourceId: 'w1',
  workspaceId: null,
  resourceName: 'Classic',
  title: 'Over-Sized Warehouse',
  config: { size: 'SMALL', type: 'CLASSIC' },
  dailyCost: 4,
  ...over,
})

const view = (size: string | null, windowCost: number | null, findings: Partial<SavingsFinding>[] = [], window = WINDOW) =>
  ({
    platform: 'databricks',
    window,
    findings,
    skipped: [],
    limited: [],
    pricing: 'list price',
    inventory: [{ id: 'w1', name: 'Classic', type: 'CLASSIC', size, windowCost }],
  }) as unknown as SavingsView

const flagged = [{ checkId: 'wh_oversized', resourceId: 'w1', resourceType: 'sql_warehouse', workspaceId: null }]

// Each setting × known or unknown when drafted × known or unknown now × the same or a different value: the settings
// the record keeps after the run, whether the run counts a change, and the line. The other setting is known and the
// same on both sides, so every line has something it compared.
const SETTING_CASES = [
  { setting: 'size', a: 'SMALL', b: 'X_SMALL', other: 'type', otherValue: 'CLASSIC' },
  { setting: 'type', a: 'CLASSIC', b: 'PRO', other: 'size', otherValue: 'SMALL' },
] as const
const rowView = (config: WarehouseConfig) =>
  ({
    platform: 'databricks',
    window: WINDOW,
    findings: [],
    skipped: [],
    limited: [],
    pricing: 'list price',
    inventory: [{ id: 'w1', name: 'Classic', type: config.type, size: config.size, windowCost: 7 }],
  }) as unknown as SavingsView
// The other setting is either known when drafted and the same now, or unknown when drafted and read now: a run in
// which a known setting changed fills nothing, since its values are the warehouse after the change.
for (const { setting, a, b, other, otherValue } of SETTING_CASES) {
  for (const otherBefore of ['known', 'unknown'] as const) {
    for (const before of ['known', 'unknown'] as const) {
      for (const after of ['known', 'unknown'] as const) {
        for (const same of [true, false]) {
          test(`fix ${setting}: ${before} when drafted, ${after} now, ${same ? 'same' : 'different'} value; ${other} ${otherBefore === 'known' ? 'known throughout' : 'read only now'}`, () => {
            const was = { [other]: otherBefore === 'known' ? otherValue : null, [setting]: before === 'known' ? a : null } as WarehouseConfig
            const now = { [other]: otherValue, [setting]: after === 'known' ? (same ? a : b) : null } as WarehouseConfig
            const drafted = fix({ config: was, changedSeen: '2026-11-10' })
            const view = rowView(now)
            // Changed: only a setting known on both sides, with different values.
            const changed = before === 'known' && after === 'known' && !same
            // Merge: a known setting is never overwritten; an unknown one takes what this run read, unless this run
            // saw a change.
            const kept = mergedConfig(drafted, view) ?? was
            expect(kept[setting]).toBe(before === 'known' ? a : after === 'known' ? now[setting] : null)
            expect(kept[other]).toBe(otherBefore === 'known' ? otherValue : changed ? null : otherValue)
            // The line names only the settings known both then and now; with none, it claims nothing.
            const named = (['size', 'type'] as const).filter(one => was[one] !== null && now[one] !== null)
            expect(fixChanged(drafted, view)).toBe(named.length === 0 ? null : changed)
            const label = named.map(one => (one === 'size' ? now.size!.replace(/_/g, '-') : now.type!)).join(' ')
            expect(fixProgress(drafted, view).text).toBe(
              named.length === 0
                ? 'Classic: fix drafted 2026-11-01, but its size and type were not read both then and now, so nothing is claimed yet.'
                : changed
                  ? `Classic: changed to ${label} since 2026-11-10: observed spend $4.00 a day before, $1.00 a day now (measured from Databricks billing). ${OBSERVED_NOTE}`
                  : `Classic: fix drafted 2026-11-01, but it is still ${label}: it is no longer flagged, and its ${named.join(' and ')} did not change, so no saving is claimed.`,
            )
          })
        }
      }
    }
  }
}

test('a fix drafted with its size unknown does not take the size of a run in which its type changed', () => {
  // Drafted against CLASSIC with no size read. This run reads MEDIUM PRO: MEDIUM is the size after the change.
  const drafted = fix({ config: { size: null, type: 'CLASSIC' }, changedSeen: '2026-11-10' })
  const view = rowView({ size: 'MEDIUM', type: 'PRO' })
  expect(mergedConfig(drafted, view)).toBeNull()
  expect(fixChanged(drafted, view)).toBe(true)
  // The line names the type alone: the size it was drafted at was never read.
  expect(fixProgress(drafted, view).text).toBe(`Classic: changed to PRO since 2026-11-10: observed spend $4.00 a day before, $1.00 a day now (measured from Databricks billing). ${OBSERVED_NOTE}`)
})

test('a fix whose settings were not read both then and now claims nothing yet, and keeps what this run read', () => {
  for (const config of [{ size: null, type: null }, 'SMALL CLASSIC', '? PRO']) {
    // The strings an older version kept load with every setting unknown.
    const drafted = fix({ config: config as WarehouseConfig, changedSeen: '2026-11-10' })
    const view = rowView({ size: 'X_SMALL', type: 'PRO' })
    expect(fixChanged(drafted, view)).toBeNull()
    expect(fixProgress(drafted, view).text).toBe('Classic: fix drafted 2026-11-01, but its size and type were not read both then and now, so nothing is claimed yet.')
    expect(mergedConfig(drafted, view)).toEqual({ size: 'X_SMALL', type: 'PRO' })
  }
})

test('a run that reads one setting but not another keeps what the record knew, so a later resize still shows', () => {
  const drafted = fix({ config: { size: 'SMALL', type: null } })
  const merged = mergedConfig(drafted, rowView({ size: null, type: 'PRO' }))
  expect(merged).toEqual({ size: 'SMALL', type: 'PRO' })
  expect(fixChanged({ ...drafted, config: merged }, rowView({ size: 'X_SMALL', type: 'PRO' }))).toBe(true)
})

test('with one workspace read, a finding that names a workspace the fix did not is still the fix\'s finding', () => {
  const drafted = fix({ checkId: 'high_idle_time', config: null, workspaceId: null })
  const withId = { ...view('SMALL', 7, [{ ...flagged[0]!, checkId: 'high_idle_time', workspaceId: 'w1' }]), checked: { workspaces: 1 } } as unknown as SavingsView
  expect(fixChanged(drafted, withId)).toBe(false)
})

test('only whole days after the date count, and never more than the window', () => {
  expect(daysAfter('2026-11-10', WINDOW)).toBe(7)
  // The day itself is partly before any change, so the window is not yet all after it.
  expect(daysAfter('2026-11-11', WINDOW)).toBe(6)
  expect(daysAfter('2026-11-14', WINDOW)).toBe(3)
  expect(daysAfter('2026-11-17', WINDOW)).toBe(0)
  expect(daysAfter('2026-11-20', WINDOW)).toBe(0)
  expect(daysAfter('2026-01-01', WINDOW)).toBe(7)
  expect(daysAfter('not a date', WINDOW)).toBe(0)
})

test('a size fix is compared by size; any other fix by its finding clearing', () => {
  expect(fixConfig({ checkId: 'wh_oversized', config: { size: 'SMALL', type: 'CLASSIC' } })).toEqual({ size: 'SMALL', type: 'CLASSIC' })
  expect(fixConfig({ checkId: 'downsize_warehouse', config: { size: 'Large', type: 'STANDARD' } })).toEqual({ size: 'Large', type: 'STANDARD' })
  expect(fixConfig({ checkId: 'high_idle_time', config: { size: 'Large', type: 'STANDARD' } })).toBeNull()
  expect(fixChanged(fix(), view('X_SMALL', 7))).toBe(true)
  expect(fixChanged(fix(), view('SMALL', 7))).toBe(false)
  const idle = fix({ checkId: 'high_idle_time', config: null })
  expect(fixChanged(idle, view('SMALL', 7, [{ ...flagged[0]!, checkId: 'high_idle_time' }]))).toBe(false)
  // Another check on the same warehouse says nothing about this fix.
  expect(fixChanged(idle, view('SMALL', 7, flagged))).toBe(true)
  expect(fixChanged(idle, view('SMALL', 7))).toBe(true)
  // Not listed, or its check did not run: this run cannot tell.
  expect(fixChanged(fix({ resourceId: 'gone' }), view('X_SMALL', 7))).toBeNull()
  const skipped = { ...view('SMALL', 7), skipped: ['Over-Sized Warehouse (refused)'] } as SavingsView
  expect(fixChanged(fix({ checkId: 'high_idle_time', config: null }), skipped)).toBeNull()
})

test('days count from the first run that saw the change, not from the draft', () => {
  // Drafted long before; the change was first seen three days before the window ends.
  const line = fixProgress(fix({ changedSeen: '2026-11-14' }), view('X_SMALL', 7))
  expect(line.state).toBe('measuring')
  expect(line.text).toBe('Classic: fix drafted 2026-11-01 · measuring (3 of 7 days)')
  // Seen by this very run: nothing is measured yet.
  expect(fixProgress(fix(), view('X_SMALL', 7)).text).toBe('Classic: fix drafted 2026-11-01 · measuring (0 of 7 days)')
})

test('with the whole window after the change, the line gives the observed spend before and after, never a saving', () => {
  const line = fixProgress(fix({ changedSeen: '2026-11-10' }), view('X_SMALL', 7))
  expect(line.state).toBe('lower')
  // The two amounts are billed in different weeks: a quieter week lowers the bill whether or not the change did.
  expect(line.text).toBe(
    'Classic: changed to X-SMALL CLASSIC since 2026-11-10: observed spend $4.00 a day before, $1.00 a day now (measured from Databricks billing). Billed in different weeks, so a change in workload moves these too: not a measured saving.',
  )
  expect(line.text).not.toMatch(/saved/i)
})

test('a fix that changes no size never earns a saving: its finding clearing may be usage falling', () => {
  const idle = fix({ checkId: 'high_idle_time', config: null, platform: 'snowflake', changedSeen: '2026-11-10' })
  const line = fixProgress(idle, view('SMALL', 7))
  expect(line.state).toBe('no_saving')
  expect(line.text).toBe('Classic: no longer flagged since 2026-11-10: $4.00 a day before, $1.00 a day now (measured from Snowflake billing). The answer does not show whether your change did that, so no saving is claimed.')
  expect(line.text).not.toContain('saved since')
  const still = fixProgress(fix({ checkId: 'high_idle_time', config: null }), view('SMALL', 7, [{ ...flagged[0]!, checkId: 'high_idle_time' }]))
  expect(still.state).toBe('unchanged')
  expect(still.text).toBe('Classic: fix drafted 2026-11-01, and it is still flagged, so no saving is claimed.')
})

test('when the check behind a fix did not run, its finding being absent claims nothing', () => {
  const skipped = (over: Partial<FixRecord>) => fixProgress(fix(over), { ...view('SMALL', 1), skipped: ['Over-Sized Warehouse (Insufficient privileges)'] } as SavingsView)
  expect(skipped({ checkId: 'high_idle_time', config: null, changedSeen: '2026-11-10' }).text).toBe('Classic: fix drafted 2026-11-01, but its check did not run in full this time, so nothing is claimed.')
  expect(skipped({ checkId: 'c', resourceType: 'cluster', resourceId: 'c1', config: null }).text).toContain('its check did not run in full this time')
})

test('a change that did not lower the cost claims nothing', () => {
  const line = fixProgress(fix({ changedSeen: '2026-11-10' }), view('X_SMALL', 35))
  expect(line.state).toBe('no_saving')
  expect(line.text).toContain('its cost did not fall: $4.00 a day before, $5.00 a day now')
  expect(fixProgress(fix({ changedSeen: '2026-11-10' }), view('X_SMALL', 28)).state).toBe('no_saving')
})

test('an unchanged warehouse claims nothing, flagged or not, however long ago the draft was', () => {
  const still = fixProgress(fix(), view('SMALL', 7, flagged))
  expect(still.state).toBe('unchanged')
  expect(still.text).toBe('Classic: fix drafted 2026-11-01, but it is still SMALL CLASSIC and still flagged, so no saving is claimed.')
  const quiet = fixProgress(fix(), view('SMALL', 1))
  expect(quiet.state).toBe('unchanged')
  expect(quiet.text).toContain('no longer flagged, and its size and type did not change')
  expect(quiet.text).not.toContain('saved')
})

test('while the window still reaches back before the draft, an unchanged resource is being measured', () => {
  const recent = fix({ date: '2026-11-14' })
  const line = fixProgress(recent, view('SMALL', 7, flagged))
  expect(line.state).toBe('measuring')
  expect(line.text).toBe('Classic: fix drafted 2026-11-14 · measuring (3 of 7 days): still SMALL CLASSIC, no change seen yet')
  const idle = fix({ date: '2026-11-14', checkId: 'high_idle_time', config: null })
  expect(fixProgress(idle, view('SMALL', 7, [{ ...flagged[0]!, checkId: 'high_idle_time' }])).text).toBe('Classic: fix drafted 2026-11-14 · measuring (3 of 7 days): still flagged, no change seen yet')
  const cluster = fix({ date: '2026-11-14', checkId: 'c', resourceType: 'cluster', resourceId: 'c1', resourceName: 'shared', config: null })
  expect(fixProgress(cluster, view('SMALL', 7, [{ checkId: 'c', resourceId: 'c1', resourceType: 'cluster', workspaceId: null }])).text).toBe('shared: fix drafted 2026-11-14 · measuring (3 of 7 days): still flagged, no change seen yet')
})

test('a read cut short, like a skipped check, says nothing about a finding being gone', () => {
  const cut = { ...view('SMALL', 1), limited: ['active periods'] } as SavingsView
  expect(fixChanged(fix({ checkId: 'high_idle_time', config: null }), cut)).toBeNull()
  expect(fixProgress(fix({ checkId: 'high_idle_time', config: null }), cut).state).toBe('unmeasured')
  // A size is read whatever else was cut short.
  expect(fixChanged(fix(), { ...view('X_SMALL', 1), limited: ['jobs'] } as SavingsView)).toBe(true)
})

test('costs priced differently are not compared', () => {
  const line = fixProgress(fix({ changedSeen: '2026-11-10', pricing: "your account's $3.00 a credit" }), view('X_SMALL', 7))
  expect(line.state).toBe('unmeasured')
  expect(line.text).toContain('priced differently')
})

test('a cost not known on both sides, or a warehouse no longer listed, gives no amount', () => {
  expect(fixProgress(fix({ dailyCost: null, changedSeen: '2026-11-10' }), view('X_SMALL', 7)).state).toBe('unmeasured')
  expect(fixProgress(fix({ changedSeen: '2026-11-10' }), view('X_SMALL', null)).state).toBe('unmeasured')
  expect(fixProgress(fix({ resourceId: 'gone' }), view('X_SMALL', 7)).text).toContain('did not list it')
})

test('a cluster or job is never given a saving: its cost afterwards is not in the answer', () => {
  const cluster = fix({ checkId: 'ap_idle_cluster', resourceType: 'cluster', resourceId: 'c1', resourceName: 'shared', config: null })
  const still = fixProgress(cluster, view('SMALL', 7, [{ checkId: 'ap_idle_cluster', resourceId: 'c1', resourceType: 'cluster', workspaceId: null }]))
  expect(still.state).toBe('unchanged')
  expect(still.text).toBe('shared: fix drafted 2026-11-01, and it is still flagged, so no saving is claimed.')
  const gone = fixProgress(cluster, view('SMALL', 7))
  expect(gone.state).toBe('unmeasured')
  expect(gone.text).toContain('no amount is claimed')
})

test('the same id in another workspace is another resource', () => {
  const job = fix({ checkId: 'j', resourceType: 'job', resourceId: '9', workspaceId: 'a', config: null })
  expect(fixProgress(job, view('SMALL', 7, [{ checkId: 'j', resourceId: '9', resourceType: 'job', workspaceId: 'b' }])).state).toBe('unmeasured')
  expect(fixKey('c', { resourceType: 'job', resourceId: '9', workspaceId: 'a' })).not.toBe(fixKey('c', { resourceType: 'job', resourceId: '9', workspaceId: 'b' }))
})

test('a Snowflake warehouse with no usage, listed under its name, is still found', () => {
  const idle = fix({ platform: 'snowflake', checkId: 'downsize_warehouse', resourceId: '7', resourceName: 'BI_WH', config: { size: 'Large', type: 'STANDARD' }, changedSeen: '2026-11-10' })
  const listed = { platform: 'snowflake', window: WINDOW, findings: [], skipped: [], limited: [], pricing: 'list price', inventory: [{ id: 'BI_WH', name: 'BI_WH', type: 'STANDARD', size: 'Medium', windowCost: 0 }] } as unknown as SavingsView
  expect(fixProgress(idle, listed).state).toBe('lower')
})

test('a recreated Snowflake warehouse, with a new id and the same finding, is still flagged', () => {
  const idle = fix({ platform: 'snowflake', checkId: 'high_idle_time', resourceId: '7', resourceName: 'BI_WH', config: null })
  const recreated = { platform: 'snowflake', window: WINDOW, skipped: [], limited: [], pricing: 'list price', findings: [{ checkId: 'high_idle_time', resourceId: '99', resourceName: 'BI_WH', resourceType: 'sql_warehouse', workspaceId: null }], inventory: [{ id: '99', name: 'BI_WH', type: 'STANDARD', size: 'Large', windowCost: 7 }] } as unknown as SavingsView
  expect(fixChanged(idle, recreated)).toBe(false)
})

test('only a real record is read back', () => {
  expect(isFixRecord(fix())).toBe(true)
  for (const value of [null, 'x', {}, { date: 'd' }]) expect(isFixRecord(value)).toBe(false)
})
