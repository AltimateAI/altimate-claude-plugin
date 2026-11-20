import { expect, test } from 'claude-code/testing'

import type { SavingsKept, SavingsView } from '../types'
import { checksNotRun, HOSTED_CHECK_COUNT, LOCAL_CHECK_COUNT } from './savings-checks'
import { combinedTotal, limitedText } from './savings-format'
import { savingsReportHtml } from './savings-report'

const URL = 'https://app.myaltimate.com/register'

const view = (over: Partial<SavingsView> = {}): SavingsView => ({
  platform: 'databricks',
  connection: 'dbx',
  identity: 'databricks:h',
  scope: null,
  pricing: 'list price',
  ranOn: 'w0',
  window: { start: '2026-11-11', end: '2026-11-18' },
  checked: { warehouses: 3, clusters: 2, jobs: 5, workspaces: 1 },
  skipped: [],
  limited: [],
  total: { min: 10, max: 20, resources: 1 },
  findings: [
    {
      checkId: 'wh_oversized',
      title: 'Over-Sized Warehouse',
      resourceType: 'sql_warehouse',
      resourceId: 'w1',
      resourceName: 'Classic',
      matchName: 'Classic',
      workspace: null,
      workspaceId: 'ws1',
      monthlyMin: 10,
      monthlyMax: 20,
      evidence: ['used at most 10% of its cores'],
      fact: 'used at most 10% of its cores',
      dailyCost: 1,
      config: 'SMALL CLASSIC',
      fixRequest: '',
    },
  ],
  whatIf: [{ resourceId: 'w1', resourceName: 'Classic', currentLabel: 'SMALL', currentMonthly: 40, choices: [{ label: 'X-SMALL', monthlyCost: 20, monthlySaving: 20, fits: false, cores: 4, coresNeeded: 6 }] }],
  changes: [],
  inventory: [
    { id: 'w0', name: 'A', type: 'SERVERLESS', size: 'SMALL', windowCost: 5 },
    { id: 'w1', name: 'Classic', type: 'CLASSIC', size: 'SMALL', windowCost: 7 },
    { id: 'w2', name: 'B', type: 'PRO', size: 'SMALL', windowCost: 0 },
  ],
  queryCount: null,
  queriesOn: null,
  fixes: [],
  ...over,
})

const kept = (one: SavingsView): SavingsKept => ({ savedAt: 0, view: one })

test('the catalog lists every hosted check the run left out, once', () => {
  for (const platform of ['databricks', 'snowflake'] as const) {
    const rows = checksNotRun(view({ platform }))
    expect(rows.length).toBe(HOSTED_CHECK_COUNT[platform] - LOCAL_CHECK_COUNT)
    expect(new Set(rows.map(one => one.id)).size).toBe(rows.length)
  }
  const ids = checksNotRun(view()).map(one => one.id)
  for (const ran of ['wh_classic_pro_to_serverless', 'wh_oversized', 'ap_idle_cluster', 'jobs_on_all_purpose_compute']) expect(ids).not.toContain(ran)
  const snowflake = checksNotRun(view({ platform: 'snowflake' })).map(one => one.id)
  for (const ran of ['high_idle_time', 'downsize_warehouse', 'underutilized_cluster', 'frequent_restart_overcharge']) expect(snowflake).not.toContain(ran)
})

test('a row states only counts this run holds', () => {
  const rows = Object.fromEntries(checksNotRun(view()).map(one => [one.id, one.reads]))
  expect(rows.wh_idle_ratio).toBe('3 SQL warehouses: not ranked by idle time')
  expect(rows.apc_zombie_cluster).toBe('2 all-purpose clusters: billing not compared with node telemetry')
  expect(rows.wh_stale_warehouse).toBe('1 of 3 SQL warehouses billed nothing in these 7 days, not checked further')
  expect(rows.ap_driver_oversized).toBe('2 all-purpose clusters: drivers not compared with their workers')
  expect(rows.jobs_hung_runs).toBe('5 jobs on all-purpose compute, of possibly more: runs not checked for hangs')
  expect(rows.wh_undersized_concurrency).toBe('3 SQL warehouses not ranked for queueing')
  const counted = Object.fromEntries(checksNotRun(view({ queryCount: 4326, queriesOn: 'CLASSIC' })).map(one => [one.id, one.reads]))
  expect(counted.wh_undersized_concurrency).toBe('4,326 queries on CLASSIC not ranked for queueing')
  expect(Object.fromEntries(checksNotRun(view({ queryCount: 5, queriesOn: null })).map(one => [one.id, one.reads])).wh_undersized_concurrency).toBe('5 queries on the flagged warehouses not ranked for queueing')
  // None seen: the row says that and claims nothing about them.
  const none = Object.fromEntries(checksNotRun(view({ checked: { warehouses: 3, clusters: 0, jobs: 0, workspaces: 1 } })).map(one => [one.id, one.reads]))
  expect(none.ap_driver_oversized).toBe('no all-purpose clusters in these 7 days')
  // The run counts only jobs on all-purpose compute: none there does not mean no jobs.
  expect(none.jobs_hung_runs).toBe('not read: this run counts only jobs on all-purpose compute, and saw none')
  // One cost not known: "billed nothing" would be a guess.
  const unknown = view({ inventory: [{ id: 'w0', name: 'A', type: 'PRO', size: null, windowCost: null }] })
  expect(Object.fromEntries(checksNotRun(unknown).map(one => [one.id, one.reads])).wh_stale_warehouse).toBe('3 SQL warehouses not checked for disuse')
})

test('a count the run could not read is said to be unread, not zero', () => {
  const skipped = view({ checked: { warehouses: 3, clusters: 0, jobs: 0, workspaces: 1 }, skipped: ['Idle Cluster Detection (PERMISSION_DENIED)', 'Job Running on All-Purpose Compute (timed out)'] })
  const rows = Object.fromEntries(checksNotRun(skipped).map(one => [one.id, one.reads]))
  expect(rows.apc_zombie_cluster).toBe('this run could not read its all-purpose clusters')
  expect(rows.jobs_hung_runs).toBe('this run could not read its jobs')
})

test('two connections on one account count a resource once, at its largest saving', () => {
  const same = view({ connection: 'other' })
  same.findings = [{ ...same.findings[0]!, monthlyMin: 12, monthlyMax: 30 }]
  expect(combinedTotal([view(), same])).toEqual({ min: 12, max: 30, resources: 1 })
  // The same id on the other platform, in another Snowflake account, or in another workspace, is another resource.
  expect(combinedTotal([view(), view({ platform: 'snowflake', scope: 'a' })]).resources).toBe(2)
  expect(combinedTotal([view({ platform: 'snowflake', scope: 'a' }), view({ platform: 'snowflake', scope: 'b' })]).resources).toBe(2)
  // A finding with no dollar estimate is no part of a dollar total.
  const noDollars = view({ connection: 'x' })
  noDollars.findings = [{ ...noDollars.findings[0]!, resourceId: 'w9', monthlyMin: 0, monthlyMax: 0 }]
  expect(combinedTotal([view(), noDollars])).toEqual({ min: 10, max: 20, resources: 1 })
  const elsewhere = view()
  elsewhere.findings = [{ ...elsewhere.findings[0]!, workspaceId: 'ws2' }]
  expect(combinedTotal([view(), elsewhere]).resources).toBe(2)
  expect(combinedTotal([view()])).toEqual({ min: 10, max: 20, resources: 1 })
})

test('the page holds the findings, what-ifs, checks not run and the Altimate link', () => {
  const html = savingsReportHtml([kept(view({ fixes: [{ resourceId: 'w1', resourceName: 'Classic', state: 'measuring', text: 'Classic: fix drafted 2026-11-14 · measuring (3 of 7 days)' }] }))], '2026-11-18 10:00 UTC', URL)
  expect(html).toContain('$10.00–$20.00 a month')
  expect(html).toContain('Classic · Over-Sized Warehouse')
  expect(html).toContain('used at most 10% of its cores')
  expect(html).toContain('no: queries would queue')
  expect(html).toContain('Stale/Orphaned Warehouse')
  expect(html).toContain('measuring (3 of 7 days)')
  expect(html).toContain(`<a href="${URL}">`)
  expect(html).toContain('Nothing was sent to Altimate')
})

test('the page is self-contained: no script, no remote asset, nothing but the one link', () => {
  const html = savingsReportHtml([kept(view())], 'now', URL)
  expect(html).not.toMatch(/<script|<img|<iframe|<link|@import|src=/i)
  expect([...html.matchAll(/https?:\/\/[^"' <)]+/g)].map(one => one[0])).toEqual([URL])
})

test('names from the warehouse cannot write into the page', () => {
  const hostile = view()
  hostile.findings = [{ ...hostile.findings[0]!, resourceName: '<script>alert(1)</script>', evidence: ['a "quoted" & <b>bold</b> line'] }]
  hostile.whatIf = []
  const html = savingsReportHtml([kept(hostile)], '<now>', URL)
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('a &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt; line')
  expect(html).toContain('&lt;now&gt;')
})

test('a choice that would cost more shows no saving, not a negative one', () => {
  const dearer = view()
  dearer.whatIf = [{ ...dearer.whatIf[0]!, choices: [{ label: 'SERVERLESS', monthlyCost: 60, monthlySaving: -20, fits: true, cores: 0, coresNeeded: 1 }] }]
  const html = savingsReportHtml([kept(dearer)], 'now', URL)
  expect(html).toContain('<td class="n">none</td>')
  expect(html).not.toContain('$-')
})

test('the page says what did not run, and does not call a partial result clean', () => {
  const partial = view({ findings: [], whatIf: [], total: { min: 0, max: 0, resources: 0 }, skipped: ['Idle Cluster Detection (PERMISSION_DENIED)'], limited: ['jobs'] })
  const html = savingsReportHtml([kept(partial)], 'now', URL)
  expect(html).toContain('Not checked: Idle Cluster Detection (PERMISSION_DENIED).')
  expect(html).toContain('Only the first 10,000 jobs were read')
  expect(html).toContain('No savings found by the checks that ran.')
  expect(html).not.toContain('No savings found by these checks.')
  expect(html).toContain('Some checks did not run in full')
})

test('a finding with no dollar estimate is shown as one, and the price is the one used', () => {
  const one = view({ platform: 'snowflake', pricing: "your account's rate of $3.00 a credit", total: { min: 0, max: 0, resources: 0 }, whatIf: [] })
  one.findings = [{ ...one.findings[0]!, monthlyMin: 0, monthlyMax: 0 }]
  const html = savingsReportHtml([kept(one)], 'now', URL)
  expect(html).toContain('1 finding, no dollar estimate')
  expect(html).toContain('Classic · Over-Sized Warehouse · no dollar estimate')
  expect(html).not.toContain('$0.00')
  expect(html).toContain('priced at your account&#39;s rate of $3.00 a credit')
})

test('the page tells same-named warehouses apart and names a platform it could not check', () => {
  const two = view()
  two.findings = [{ ...two.findings[0]!, workspace: 'ws1' }]
  const html = savingsReportHtml([kept(two)], 'now', URL, [{ platform: 'snowflake', text: 'This altimate-code has no Snowflake savings check.' }])
  expect(html).toContain('Classic (workspace ws1) · Over-Sized Warehouse')
  expect(html).toContain('The last Snowflake check did not finish: This altimate-code has no Snowflake savings check.')
  expect(html).toContain('Some checks did not run in full')
})

test('two platforms priced differently are not run together in one phrase', () => {
  const html = savingsReportHtml([kept(view()), kept(view({ platform: 'snowflake', scope: 'a', pricing: "your account's $3.00 a credit" }))], 'now', URL)
  expect(html).toContain('at the prices shown for each platform')
})

test('a resize the run saw is on the page too', () => {
  const html = savingsReportHtml([kept(view({ changes: [{ name: 'Classic', from: 'SMALL CLASSIC', to: 'X-SMALL CLASSIC', since: '2026-11-10', monthlyBefore: 118, monthlyNow: 59 }] }))], 'now', URL)
  expect(html).toContain(
    '<p>Classic: SMALL CLASSIC → X-SMALL CLASSIC since 2026-11-10. Observed spend: $118.00 a month before, $59.00 after. Billed in different weeks, so a change in workload moves these too: not a measured saving.</p>',
  )
  expect(html).not.toMatch(/saved/i)
})

test('nothing from the answer can put a control character on the page', () => {
  const dirty = view({ connection: 'c\u001b[2Jonn', skipped: ['Check (bad\u0007 thing)'], limited: ['rows\u001b'] })
  dirty.findings = [{ ...dirty.findings[0]!, evidence: ['line\u0000 one'] }]
  const html = savingsReportHtml([kept(dirty)], 'now', URL, [{ platform: 'snowflake', text: 'driver\u001b[31m error' }])
  expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(html)).toBe(false)
  expect(html).toContain('driver [31m error')
})

test('the limit named is the one that query has', () => {
  expect(limitedText({ platform: 'snowflake', limited: ['warehouses', 'active periods'] })).toBe('Only the first 9,999 warehouses and the first 100,000 rows of active periods were read; any beyond them were not checked.')
  expect(limitedText({ platform: 'databricks', limited: ['jobs'] })).toBe('Only the first 10,000 jobs were read; any beyond them were not checked.')
  expect(limitedText({ platform: 'databricks', limited: [] })).toBeNull()
})

test('each section says when it was checked', () => {
  expect(savingsReportHtml([{ savedAt: Date.parse('2026-11-12T08:00:00Z'), view: view() }], 'now', URL)).toContain('checked 2026-11-12')
})

test('a change whose observed spend fell is plain text, never drawn as a saving; other states are dimmed', () => {
  const lines = view({ fixes: [{ resourceId: 'a', resourceName: 'A', state: 'lower', text: 'A lower' }, { resourceId: 'b', resourceName: 'B', state: 'unchanged', text: 'B unchanged' }] })
  const html = savingsReportHtml([kept(lines)], 'now', URL)
  expect(html).toContain('<p>A lower</p>')
  expect(html).toContain('<p class="gap">B unchanged</p>')
  expect(html).not.toContain('class="saved"')
})

test('a clean result says so, and both platforms get a section', () => {
  const html = savingsReportHtml([kept(view({ findings: [], whatIf: [], total: { min: 0, max: 0, resources: 0 } })), kept(view({ platform: 'snowflake', connection: 'sf', findings: [], whatIf: [], total: { min: 0, max: 0, resources: 0 } }))], 'now', URL)
  expect(html).toContain('No savings found')
  expect(html).toContain('<h2>Databricks</h2>')
  expect(html).toContain('<h2>Snowflake</h2>')
})
