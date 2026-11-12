import { describe, expect, test } from 'claude-code/testing'

import { MIN_ALTIMATE_CODE } from './altimate-cli'
import {
  answerOf,
  changedColumns,
  columnReportData,
  type ColumnAnswer,
  type ColumnTrace,
  consumersOf,
  DEFAULT_LEVELS,
  fingerprint,
  focusOf,
  impactWords,
  MAY_CARRY_REASONS,
  mayCarryGroups,
  mergeConsumers,
  type ModelChange,
  openersFor,
  planLines,
  reachOf,
  reportData,
  reportHtml,
  sectionOf,
  summaryLines,
  summaryOf,
  upstreamWords,
  WINDOWS_EXPLORER,
} from './impact-report'

// A synthetic project: orders → fct_orders.revenue → three hops of readers.
export const DOWN: ColumnAnswer = {
  version: 1,
  focus: { model: 'model.shop.fct_orders', column: 'revenue' },
  direction: 'downstream',
  inputs: { manifest: { generated_at: '2026-01-01', older_than_sql: false }, sql: 'compiled_code', catalog: null, engine: 'core 1.0', workarounds: [] },
  counts: { columns: 4, models: 3, hops: 3, contracts: 1, ends: 2, may_carry_models: 3, model_level: 6 },
  nodes: [
    { id: 'model.shop.fct_orders', name: 'fct_orders', folder: 'marts', materialized: 'table', contract: false, tests: 1, exposures: [] },
    { id: 'model.shop.fct_revenue_daily', name: 'fct_revenue_daily', folder: 'marts', materialized: 'table', contract: true, tests: 2, exposures: ['exec_revenue'] },
    { id: 'model.shop.rpt_finance', name: 'rpt_finance', folder: 'reports', materialized: 'view', contract: false, tests: 0, exposures: [] },
    { id: 'model.shop.rpt_board', name: 'rpt_board', folder: 'reports', materialized: 'view', contract: false, tests: 0, exposures: [] },
    { id: 'model.shop.rpt_misc', name: 'rpt_misc', folder: 'reports', materialized: 'view', contract: false, tests: 0, exposures: [] },
    { id: 'model.shop.rpt_broken', name: 'rpt_broken', folder: 'reports', materialized: 'view', contract: false, tests: 0, exposures: [] },
  ],
  columns: [
    { model: 0, column: 'revenue', hop: 0, how: null as any, how_from: null as any },
    { model: 1, column: 'daily_revenue', hop: 1, type: 'number' },
    { model: 1, column: 'revenue', hop: 1, end: true, how: '=', how_from: 'name' },
    { model: 2, column: 'weekly_revenue', hop: 2 },
    { model: 3, column: 'board_revenue', hop: 3, end: true },
  ],
  edges: [
    [0, 1, 'Σ'],
    [0, 2, '=', 'name'],
    [1, 3, 'ƒ'],
    [3, 4, '~', 'name'],
  ],
  also_reads: [{ model: 4, columns: ['revenue'], downstream: 2 }],
  unresolved: [{ model: 5, reason: 'parse error', code: 'unresolved' }],
  flags: [{ model: 2, flag: 'filter_rewritten' }],
  // Every other model at the model level, with the first reason found: nothing is reported unaffected.
  may_carry: [
    { id: 'model.shop.rpt_misc', name: 'rpt_misc', reason: 'names_column' },
    { id: 'model.shop.rpt_broken', name: 'rpt_broken', reason: 'unresolved' },
    { id: 'model.shop.rpt_after_broken', name: 'rpt_after_broken', reason: 'below', via: 'rpt_broken' },
  ],
  truncated: false,
}

export const UP: ColumnAnswer = {
  version: 1,
  focus: { model: 'model.shop.fct_orders', column: 'revenue' },
  direction: 'upstream',
  nodes: [
    { id: 'model.shop.fct_orders', name: 'fct_orders' },
    { id: 'model.shop.int_orders', name: 'int_orders' },
    { id: 'source.shop.raw.orders', name: 'orders' },
  ],
  columns: [
    { model: 0, column: 'revenue', hop: 0, how: null as any, how_from: null as any },
    { model: 1, column: 'amount', hop: 1 },
    { model: 2, column: 'amount_cents', hop: 2, end: true },
  ],
  edges: [
    // Two edges into the focus: the traced aggregate is its how, not the name match.
    [1, 0, 'Σ'],
    [2, 0, 'Σ', 'name'],
    [2, 1, 'ƒ'],
  ],
}

export const CHANGE: ModelChange = {
  model: 'fct_orders',
  file: 'models/fct_orders.sql',
  root: '/repo',
  columns: [{ name: 'revenue', before: 'sum(amount) as revenue', after: 'sum(amount) - sum(refunds) as revenue' }],
}
const TRACE: ColumnTrace = { model: 'fct_orders', column: 'revenue', down: DOWN, up: UP, modelLevel: 6, failed: false }
const TASK = { finishedAt: '2026-01-01 00:00 UTC', builtAt: '2026-01-01 00:05 UTC', manifest: 'the manifest as it was when the task started', movedOn: [] as string[] }
/** Words as the page reads them, with names in backticks. */
const plain = (lines: (string | { code: string })[][]) => lines.map(line => line.map(one => (typeof one === 'string' ? one : `\`${one.code}\``)).join(''))

/** The data a report embeds, read back out of its page. */
export function embedded(html: string): any {
  const match = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html)
  return match ? JSON.parse(match[1]!) : null
}

describe('changed columns', () => {
  test('a rewritten select item is the changed column, with its expression before and after', () => {
    const before = 'select\n  order_id,\n  sum(amount) as revenue\nfrom orders\ngroup by 1'
    const after = 'select\n  order_id,\n  sum(amount) - sum(refunds) as revenue\nfrom orders\ngroup by 1'
    expect(changedColumns(before, after)).toEqual([{ name: 'revenue', before: 'sum(amount) as revenue', after: 'sum(amount) - sum(refunds) as revenue' }])
  })

  test('a filter change touches no output column, and at most three columns are kept', () => {
    expect(changedColumns('select a, b from t where x = 1', 'select a, b from t where x = 2')).toEqual([])
    const wide = changedColumns('select 1 as a, 1 as b, 1 as c, 1 as d from t', 'select 2 as a, 2 as b, 2 as c, 2 as d from t')
    expect(wide.length).toBe(3)
  })

  test('a removed column has no expression after', () => {
    expect(changedColumns('select a, b from t', 'select a from t')).toEqual([{ name: 'b', before: 'b', after: null }])
  })
})

describe('the answer', () => {
  test('is read from metadata.column_answer; anything else is no answer', () => {
    expect(answerOf({ column_answer: DOWN })).toBe(DOWN)
    expect(answerOf({ severity: 'LOW', column_reach: {} })).toBeNull()
    expect(answerOf(null)).toBeNull()
  })

  test('reach takes the contract counts, and counts for itself where they are absent', () => {
    expect(reachOf(DOWN)).toEqual({ columns: 4, models: 3, ends: 2, hops: 3, mayCarry: 3, unresolved: 1, modelLevel: 6, truncated: false })
    // Without counts, the may-carry list gives its count.
    expect(reachOf({ ...DOWN, counts: undefined })).toEqual({ columns: 4, models: 3, ends: 2, hops: 3, mayCarry: 3, unresolved: 1, modelLevel: null, truncated: false })
  })
})

describe('the summary', () => {
  test('names each changed column with its reach, and says the reach is a lower bound', () => {
    const lines = summaryLines(summaryOf([CHANGE], [{ ...TRACE, up: null }], null))
    expect(lines).toEqual([
      '◆ Lineage after this task · 1 model changed',
      'fct_orders · 6 downstream models at model level',
      '  revenue  reaches 4 columns in 3 models (2 end columns) · 3 more may change',
      '⚠ Lower bound: 1 model could not be read',
    ])
  })

  test('a model with no changed output column shows its model-level count alone', () => {
    const change = { ...CHANGE, columns: [] }
    const lines = summaryLines(summaryOf([change], [{ model: 'fct_orders', column: null, down: null, up: null, modelLevel: 6, failed: false }], null))
    expect(lines).toEqual(['◆ Lineage after this task · 1 model changed', 'fct_orders · 6 downstream models at model level', '  no output column changed: the model-level count stands'])
  })
})

describe('what to expect downstream, in plain words', () => {
  test('says what the value reaches, what may change, what should not, what to watch and how sure it is', () => {
    expect(plain(impactWords('fct_orders', 'revenue', TRACE))).toEqual([
      '`fct_orders` has 6 models downstream. The value of `revenue` flows into 3 of them, in 4 columns. Expect those to change with it: `fct_revenue_daily`, `rpt_finance` and `rpt_board`.',
      "3 more may change: the value wasn't traced to them, and nothing rules them out. \u201cMay carry it\u201d below says why, model by model.",
      'One model it reaches enforces a contract, so a type change can fail the build there: `fct_revenue_daily`.',
      'Tests on the models it reaches: 2.',
      "1 model couldn't be read, so the real numbers can only be higher.",
    ])
  })

  test('caps the names, says when the changed model has a contract, and when everything was read', () => {
    const nodes = Array.from({ length: 7 }, (_, i) => ({ id: `model.s.m${i}`, name: `m${i}`, contract: i === 0, tests: 0 }))
    const down: ColumnAnswer = {
      ...DOWN,
      nodes,
      columns: [{ model: 0, column: 'x', hop: 0 }, ...nodes.slice(1).map((_, i) => ({ model: i + 1, column: 'x', hop: 1 }))],
      counts: { columns: 6, models: 6, ends: 6, may_carry_models: 0, model_level: 6 },
      also_reads: [],
      unresolved: [],
      may_carry: [],
    }
    expect(plain(impactWords('m0', 'x', { ...TRACE, model: 'm0', column: 'x', down, modelLevel: 6 }))).toEqual([
      '`m0` has 6 models downstream. The value of `x` flows into 6 of them, in 6 columns. Expect those to change with it: `m1`, `m2`, `m3`, `m4`, `m5` and 1 more.',
      '`m0` enforces a contract, so a type change can fail its build.',
      'Every downstream model was read.',
    ])
  })

  test('a model with no changed column has its count alone; a failed trace says so; nothing downstream says so', () => {
    expect(plain(impactWords('m', null, { model: 'm', column: null, down: null, up: null, modelLevel: 6, failed: false }))).toEqual([
      "`m` has 6 models downstream. No output column changed (a filter or a join, say), so this can't say which of them are affected.",
    ])
    expect(plain(impactWords('m', 'c', { model: 'm', column: 'c', down: null, up: null, modelLevel: 6, failed: true }))).toEqual(['`m` has 6 models downstream. The column `c` could not be traced.'])
    expect(plain(impactWords('m', null, { model: 'm', column: null, down: null, up: null, modelLevel: 0, failed: false }))).toEqual(['Nothing sits downstream of `m`. '])
  })
})

describe('consumers', () => {
  const answerWith = (consumers: unknown) => ({ column_answer: { ...DOWN, consumers }, exposures_declared: 9 })
  const exposure = (name: string, tier: string, via: string[], more = {}) => ({ unique_id: `exposure.s.${name}`, name, label: name, type: 'dashboard', tier, via, ...more })

  test('a column answer gives the tiers; a model-only result gives the list, untiered, and the declared count', () => {
    const tiered = consumersOf(answerWith({ declared: 2, exposures: [exposure('board', 'carries', ['rpt_board'], { url: 'https://bi.example.com/1', owner: 'Data' })] }))
    expect(tiered).toEqual({
      declared: 2,
      error: null,
      list: [{ id: 'exposure.s.board', label: 'board', type: 'dashboard', url: 'https://bi.example.com/1', owner: 'Data', tier: 'carries', via: ['rpt_board'], columns: [] }],
    })
    const modelOnly = consumersOf({ exposures_declared: 1, exposures: [{ unique_id: 'exposure.s.a', name: 'a', label: 'A', type: 'notebook' }] })
    expect(modelOnly.declared).toBe(1)
    expect(modelOnly.list[0]).toMatchObject({ label: 'A', tier: null, via: [] })
  })

  test('none declared and exposures that could not be read stay apart, and an older answer is unknown', () => {
    expect(consumersOf({ exposures_declared: 0, exposures: [] })).toEqual({ declared: 0, error: null, list: [] })
    expect(consumersOf({ exposures: [], exposures_error: 'bad manifest' })).toEqual({ declared: null, error: 'bad manifest', list: [] })
    expect(consumersOf(null)).toEqual({ declared: null, error: null, list: [] })
  })

  test('only a web address becomes a link', () => {
    const list = consumersOf({ exposures: [{ name: 'x', url: 'javascript:alert(1)' }, { name: 'y', url: 'HTTP://bi.example.com' }] }).list
    expect(list.map(one => one.url)).toEqual([null, 'HTTP://bi.example.com'])
  })

  test('across columns an exposure is listed once, in its closest tier, naming the columns', () => {
    const trace = (column: string, tier: string, name = 'board') => ({
      ...TRACE,
      column,
      consumers: consumersOf(answerWith({ declared: 3, exposures: [exposure(name, tier, ['m'])] })),
    })
    const merged = mergeConsumers([trace('a', 'may_carry'), trace('b', 'carries'), trace('c', 'may_carry'), trace('d', 'may_carry', 'other')])
    expect(merged.declared).toBe(3)
    expect(merged.list.map(one => [one.label, one.tier, one.columns])).toEqual([
      ['board', 'carries', ['fct_orders.a', 'fct_orders.b', 'fct_orders.c']],
      ['other', 'may_carry', ['fct_orders.d']],
    ])
  })

  test('the report carries them and says what it leaves out', () => {
    const none = reportHtml(reportData([CHANGE], [{ ...TRACE, consumers: consumersOf({ exposures_declared: 0, exposures: [] }) }], TASK))
    expect(embedded(none).consumers).toEqual({ declared: 0, error: null, list: [] })
    expect(none).toContain('This dbt project declares no exposures')
    expect(none).toContain('Only exposures a dbt project declares can appear here: other BI tools and backend services do not.')
  })
})

describe('a plan', () => {
  const model = { name: 'mrt_usage', modelLevel: 39, tests: 307, exposures: 0, declared: 0, failed: false }

  test('names its models at the model level and says nothing has changed yet', () => {
    expect(planLines({ state: 'ready', models: [model, { ...model, name: 'stg_a', modelLevel: 1, tests: 1, exposures: 2, declared: 4 }, { ...model, name: 'stg_b', modelLevel: null, tests: null, exposures: null, failed: true }], more: 2 })).toEqual([
      '◆ Before this plan · it names 5 dbt models · model level, nothing has changed yet',
      'mrt_usage · 39 downstream models · 307 tests · no exposures declared',
      'stg_a · 1 downstream model · 1 test · 2 exposures',
      'stg_b · could not be read',
      '… and 2 more',
    ])
  })

  test('while it looks them up, says so', () => {
    expect(planLines({ state: 'tracing', models: [{ ...model, modelLevel: null, tests: null, exposures: null, declared: null }], more: 0 })[1]).toBe('mrt_usage · tracing…')
  })
})

describe('a column looked up by name', () => {
  test('says what it is made from one hop up, how far back it goes, where it starts and how sure that is', () => {
    expect(plain(upstreamWords('fct_orders', 'revenue', UP))).toEqual([
      '`revenue` in `fct_orders` is aggregated from 1 column one hop up: `int_orders.amount`.',
      'Followed all the way back, it draws on 2 columns in 2 models, up to 2 hops away.',
      'Where it starts: `orders`.',
      'Every upstream model was read.',
    ])
    expect(plain(upstreamWords('fct_orders', 'revenue', { ...UP, unresolved: [{ model: 1, reason: 'unparsed' }], truncated: true })).pop()).toBe(
      "1 model upstream couldn't be read and the trace hit its limit, so more may feed it.",
    )
    expect(plain(upstreamWords('fct_orders', 'revenue', null))).toEqual(['Where `fct_orders.revenue` comes from could not be traced.'])
    expect(plain(upstreamWords('fct_orders', 'revenue', { ...UP, columns: [UP.columns[0]!], edges: [] }))).toEqual([
      "`revenue` in `fct_orders` reads no column the trace could follow: a constant, say, or SQL the engine couldn't read.",
    ])
  })

  test('says where its value goes without talk of a change or a contract', () => {
    const words = plain(impactWords('fct_orders', 'revenue', TRACE, true))
    expect(words[0]).toBe(
      '`fct_orders` has 6 models downstream. The value of `revenue` flows into 3 of them, in 4 columns. A wrong value here shows up there too: `fct_revenue_daily`, `rpt_finance` and `rpt_board`.',
    )
    expect(words.some(line => /contract|Expect those|may change/.test(line))).toBe(false)
    expect(words).toContain("3 more may carry it: the value wasn't traced to them, and nothing rules them out. \u201cMay carry it\u201d below says why, model by model.")
  })

  test('its report has no task: it leads with where the column comes from, then where it goes', () => {
    const data = columnReportData('fct_orders', 'revenue', TRACE, { builtAt: TASK.builtAt, manifest: 'target/manifest.json as it is now' })
    expect(data).toMatchObject({ title: 'Column lineage · fct_orders.revenue', lookup: { model: 'fct_orders', column: 'revenue' }, changes: [], finishedAt: '' })
    expect(data.focuses[0]!.upstream).toEqual(upstreamWords('fct_orders', 'revenue', UP))
    expect(data.focuses[0]!.before).toBeNull()
    const html = reportHtml(data)
    const at = (one: string) => html.indexOf(one, html.indexOf('function render(){'))
    expect(html).toContain("side.appendChild(DATA.lookup?upstreamPanel():ch)")
    expect(at("if(DATA.lookup){var uc=0")).toBeLessThan(at("if(r){stats.appendChild(stat(r.columns,'columns downstream',"))
    expect(html).toContain("'Where it comes from'")
    expect(html).toContain("DATA.lookup?'Where it goes':'What to expect downstream'")
    expect(reportData([CHANGE], [TRACE], TASK).lookup).toBeNull()
  })
})

describe('the report', () => {
  test('leads with what changed and what to expect, and keeps the levels and paths underneath', () => {
    const html = reportHtml(reportData([{ ...CHANGE, ended: fingerprint('x') }], [TRACE], { ...TASK, movedOn: ['models/fct_orders.sql'] }))
    const order = ['What this task changed', 'side.appendChild(impactPanel())', 'side.appendChild(consumersPanel())', 'Column by column', 'graph=graphPanel(f,i)', "section(f,i,'up')", "section(f,i,'down')"].map(one => html.indexOf(one, html.indexOf('function render(){')))
    expect(order.every(one => one >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    const data = embedded(html)
    expect(data).toMatchObject({ finishedAt: TASK.finishedAt, builtAt: TASK.builtAt, movedOn: ['models/fct_orders.sql'] })
    expect(data.focuses[0].impact.length).toBeGreaterThan(2)
    expect(html).toContain('This report describes the task, not the files as they are now.')
  })

  test('groups downstream by hop then model, with the how per column, ends and contracts', () => {
    const down = sectionOf(DOWN)
    expect(down.hops.map(one => one.hop)).toEqual([1, 2, 3])
    const daily = down.hops[0]!.models[0]!
    expect(daily).toMatchObject({ name: 'fct_revenue_daily', contract: true, tests: 2, exposures: ['exec_revenue'] })
    expect(daily.columns.map(one => [one.column, one.glyph, one.byName, one.end])).toEqual([
      ['daily_revenue', 'Σ', false, false],
      ['revenue', '=', true, true],
    ])
    // An edge inferred from names (its 4th element) reads as matched by name, not traced.
    const board = down.hops[2]!.models[0]!.columns[0]!
    expect([board.column, board.glyph, board.byName]).toEqual(['board_revenue', '~', true])
    expect(down.hops[1]!.models[0]!.flags).toEqual(['filter rewritten'])
    // Upstream: how each column feeds the one below it, the strongest edge when several.
    expect(sectionOf(UP).hops.map(one => one.models[0]!.columns.map(col => `${col.glyph}${col.byName ? '*' : ''}`).join())).toEqual(['Σ', 'Σ*'])
  })

  test('embeds both directions with edges keyed by model and column, folds, and two levels by default', () => {
    const html = reportHtml(reportData([CHANGE], [TRACE], TASK))
    expect(html).toContain('data-levels="2"')
    const data = embedded(html)
    expect(data.defaultLevels).toBe(DEFAULT_LEVELS)
    expect(DEFAULT_LEVELS).toBe(2)
    const focus = data.focuses[0]
    expect(focus).toMatchObject({ model: 'fct_orders', column: 'revenue', key: 'model.shop.fct_orders|revenue', glyph: 'Σ', byName: false, before: 'sum(amount) as revenue' })
    expect(focus.up.hops.map((one: any) => one.hop)).toEqual([1, 2])
    expect(focus.down.hops.map((one: any) => one.hop)).toEqual([1, 2, 3])
    // The highlight walks these edges both ways from the clicked column.
    expect(focus.edges).toContainEqual(['model.shop.int_orders|amount', 'model.shop.fct_orders|revenue', 'Σ'])
    expect(focus.edges).toContainEqual(['model.shop.rpt_finance|weekly_revenue', 'model.shop.rpt_board|board_revenue', '~'])
    expect(focus.mayCarry.map((one: any) => one.reason)).toEqual(['unresolved', 'names_column', 'below'])
    // No tier says a model is unaffected.
    expect(Object.keys(focus)).not.toContain('cleared')
    expect(focusOf(CHANGE, CHANGE.columns[0]!, { ...TRACE, down: null }).mayCarry).toBeNull()
    expect(data.changes[0].columns[0].after).toBe('sum(amount) - sum(refunds) as revenue')
  })

  test('a click shows the path bar over the page, so nothing under the pointer moves', () => {
    const html = reportHtml(reportData([CHANGE], [TRACE], TASK))
    const rule = /\.pathbar\{[^}]*\}/.exec(html)![0]
    expect(rule).toContain('position:fixed')
    expect(rule).not.toContain('sticky')
    expect(rule).not.toMatch(/margin:-/)
    // The bar lets the pointer through to the column under it; its Clear button still takes clicks.
    expect(rule).toContain('pointer-events:none')
    expect(html).toMatch(/\.pathbar button\{[^}]*pointer-events:auto/)
  })

  test('its key names every mark the graph draws, and each count says what it counts', () => {
    const html = reportHtml(reportData([CHANGE], [TRACE], TASK))
    for (const key of ['exposures on the model', 'noted by the engine', 'nothing further downstream reads it', "DATA.lookup?'the column':'the changed column'", 'Upstream on the left, downstream on the right'])
      expect(html).toContain(key)
    for (const tip of ['Columns the value reaches that nothing further downstream reads', 'Downstream models the value wasn\\u2019t traced to, which nothing rules out', 'Every model downstream of this one, whether or not the value reaches it'])
      expect(html).toContain(tip)
    expect(html).toContain("stat(r.mayCarry,'models may carry it',!r.mayCarry,")
  })

  test('is one offline file: no external resource, and project text cannot close its script', () => {
    const hostile = { ...CHANGE, model: 'x</script><script>alert(1)</script>' }
    const html = reportHtml(reportData([hostile], [{ ...TRACE, model: hostile.model }], TASK))
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//)
    expect(html).not.toContain('<script>alert(1)')
    expect(html.match(/<\/script>/g)!.length).toBe(2)
    expect(embedded(html).changes[0].model).toBe(hostile.model)
    expect(html).toContain('prefers-color-scheme:dark')
  })
})

// An answer with a model for every reason the report has to place, and one this build doesn't know.
const MANY: ColumnAnswer = {
  ...DOWN,
  counts: { ...DOWN.counts, may_carry_models: 7, model_level: 10 },
  may_carry: [
    { id: 'model.shop.rpt_after_broken', name: 'rpt_after_broken', reason: 'below', via: 'rpt_broken' },
    { id: 'model.shop.rpt_misc', name: 'rpt_misc', reason: 'names_column' },
    { id: 'model.shop.rpt_quiet', name: 'rpt_quiet', reason: 'not_traced' },
    { id: 'model.shop.rpt_broken', name: 'rpt_broken', reason: 'unresolved' },
    { id: 'model.shop.rpt_star', name: 'rpt_star', reason: 'star' },
    { id: 'model.shop.rpt_daily_extra', name: 'rpt_daily_extra', reason: 'reads_value_model', via: 'fct_revenue_daily' },
    { id: 'model.shop.rpt_new', name: 'rpt_new', reason: 'some_future_reason' },
  ],
}

describe('may carry it, by reason', () => {
  test("groups the models by reason in the contract's order, not_traced last of those, an unknown reason after, with via where it applies", () => {
    const groups = mayCarryGroups(MANY)!
    expect(groups.map(one => one.reason)).toEqual(['unresolved', 'star', 'names_column', 'reads_value_model', 'below', 'not_traced', 'some_future_reason'])
    expect(groups.map(one => plain([one.heading])[0])).toEqual([
      "Its SQL couldn't be read",
      'It selects `*`, so it may read the column without naming it',
      'It uses the column in a filter, join or grouping',
      'It reads a model the value reaches, whose other columns may change',
      'It sits past one of these',
      "The value wasn't traced to it, but nothing rules it out",
      'The engine gave the reason "some_future_reason"',
    ])
    // via for below and reads_value_model; what a names_column model reads, and why an unresolved one wasn't read.
    expect(groups.map(one => one.models)).toEqual([
      [{ name: 'rpt_broken', note: 'parse error' }],
      [{ name: 'rpt_star', note: null }],
      [{ name: 'rpt_misc', note: 'reads revenue' }],
      [{ name: 'rpt_daily_extra', note: 'reads fct_revenue_daily' }],
      [{ name: 'rpt_after_broken', note: 'past rpt_broken' }],
      [{ name: 'rpt_quiet', note: null }],
      [{ name: 'rpt_new', note: null }],
    ])
    // Every reason the contract names has the report's words, in the contract's order.
    expect(MAY_CARRY_REASONS.map(one => one[0])).toEqual(['unresolved', 'read_in_part', 'read_columns_unknown', 'ephemeral', 'unclear_sql', 'star', 'natural_join', 'dynamic_name', 'row_reference', 'names_column', 'reads_value_model', 'below', 'capped', 'not_traced'])
    expect(mayCarryGroups({ ...MANY, may_carry: [] })).toEqual([])
    expect(mayCarryGroups(null)).toBeNull()
  })

  test('the band says what the value reaches and how many more may change, and never that a model is unaffected', () => {
    const band = summaryLines(summaryOf([CHANGE], [{ ...TRACE, down: MANY, up: null }], null))[2]
    expect(band).toBe('  revenue  reaches 4 columns in 3 models (2 end columns) · 7 more may change')
  })

  test('the report draws the groups, and no section for an older answer or for models said to be unaffected', () => {
    const focus = embedded(reportHtml(reportData([CHANGE], [{ ...TRACE, down: MANY }], TASK))).focuses[0]
    expect(focus.mayCarry.map((one: any) => [one.reason, one.models.length])).toEqual([
      ['unresolved', 1],
      ['star', 1],
      ['names_column', 1],
      ['reads_value_model', 1],
      ['below', 1],
      ['not_traced', 1],
      ['some_future_reason', 1],
    ])
    const html = reportHtml(reportData([CHANGE], [TRACE], TASK))
    expect(html).toContain('if(f.mayCarry&&(f.mayCarry.length||(r&&r.mayCarry)))wrap.appendChild(mayCarryFold(f.mayCarry,r?r.mayCarry:null));\n')
    for (const gone of ['Also reads it, outside the select', "fold('Not resolved'", 'Proven unaffected', 'Cleared:', "doesn't reach'],[null", 'minCli']) expect(html).not.toContain(gone)
    expect(html).toContain("var TIERS=[['carries','Read a model the value reaches'],['may_carry','Read a model that may carry it'],[null,'Read this model or one downstream of it']];")
  })
})

// An upstream answer naming the ancestors that may also be a source, with reasons.
const UP_MAY: ColumnAnswer = {
  ...UP,
  may_carry: [
    { id: 'source.shop.raw.orders_v2', name: 'orders_v2', reason: 'below', via: 'int_orders' },
    { id: 'model.shop.stg_mystery', name: 'stg_mystery', reason: 'star' },
    { id: 'model.shop.stg_unread', name: 'stg_unread', reason: 'unresolved' },
    { id: 'model.shop.stg_quiet', name: 'stg_quiet', reason: 'not_traced' },
  ],
}

describe('where else a column may come from', () => {
  test('groups the ancestors that may also be a source by reason, one below a traced model reading as above it', () => {
    const groups = mayCarryGroups(UP_MAY, true)!
    expect(groups.map(one => [one.reason, plain([one.heading])[0], one.models])).toEqual([
      ['unresolved', "Its SQL couldn't be read", [{ name: 'stg_unread', note: null }]],
      ['star', 'It selects `*`, so it may read the column without naming it', [{ name: 'stg_mystery', note: null }]],
      ['below', 'It sits above one of these', [{ name: 'orders_v2', note: 'above int_orders' }]],
      ['not_traced', "The value wasn't traced to it, but nothing rules it out", [{ name: 'stg_quiet', note: null }]],
    ])
    expect(mayCarryGroups(UP, true)).toEqual([])
  })

  test('says how many more may be a source, and never that a model is not one', () => {
    expect(plain(upstreamWords('fct_orders', 'revenue', UP_MAY))).toEqual([
      '`revenue` in `fct_orders` is aggregated from 1 column one hop up: `int_orders.amount`.',
      'Followed all the way back, it draws on 2 columns in 2 models, up to 2 hops away.',
      'Where it starts: `orders`.',
      "4 more models upstream may also be a source: the value wasn't traced from them, and nothing rules them out. “Where else it may come from” below says why.",
      'Every upstream model was read.',
    ])
    // A constant still names the ancestors that may feed it.
    expect(plain(upstreamWords('fct_orders', 'revenue', { ...UP_MAY, columns: [UP.columns[0]!], edges: [] })).length).toBe(2)
    expect(plain(upstreamWords('fct_orders', 'revenue', UP))).toHaveLength(4)
  })

  test('the column report shows them under where it comes from', () => {
    const page = (up: ColumnAnswer) => columnReportData('fct_orders', 'revenue', { ...TRACE, up }, { builtAt: TASK.builtAt, manifest: 'm' })
    expect(page(UP_MAY).focuses[0]!.upMayCarry!.map(one => one.reason)).toEqual(['unresolved', 'star', 'below', 'not_traced'])
    expect(page(UP).focuses[0]!.upMayCarry).toEqual([])
    const html = reportHtml(page(UP_MAY))
    expect(embedded(html).focuses[0].upMayCarry).toHaveLength(4)
    expect(html).toContain("if(f.upMayCarry&&f.upMayCarry.length)p.appendChild(mayCarryFold(f.upMayCarry,null,'Where else it may come from, by reason ','fold inner'))")
  })
})

describe('the altimate-code floor', () => {
  test('is one constant, a version, named where an altimate-code gives no column answer', () => {
    expect(MIN_ALTIMATE_CODE).toMatch(/^\d+\.\d+\.\d+$/)
    const view = summaryOf([CHANGE], [{ ...TRACE, down: null, up: null, stale: true }], null)
    expect(summaryLines(view)[2]).toBe(`  revenue  no column answer: update altimate-code to ${MIN_ALTIMATE_CODE} or later`)
  })
})

describe('the opener', () => {
  test('per platform: open, xdg-open, start; on WSL wslview, explorer.exe by name then by path, xdg-open last', () => {
    const path = '/repo/target/.altimate-lineage/report.html'
    const win = '\\\\wsl.localhost\\x\\report.html'
    expect(openersFor('mac', path)).toEqual([{ argv: ['open', path], okExits: [0] }])
    expect(openersFor('linux', path)).toEqual([{ argv: ['xdg-open', path], okExits: [0] }])
    expect(openersFor('windows', path)).toEqual([{ argv: ['cmd', '/c', 'start', '', path], okExits: [0] }])
    // explorer.exe exits 1 even when it opened the file.
    expect(openersFor('wsl', path, { windowsPath: win, explorerAtC: true })).toEqual([
      { argv: ['wslview', path], okExits: [0] },
      { argv: ['explorer.exe', win], okExits: [0, 1] },
      { argv: [WINDOWS_EXPLORER, win], okExits: [0, 1] },
      { argv: ['xdg-open', path], okExits: [0] },
    ])
    expect(WINDOWS_EXPLORER).toBe('/mnt/c/Windows/explorer.exe')
    // No Windows path: nothing for explorer.exe to open.
    expect(openersFor('wsl', path, { windowsPath: null, explorerAtC: true }).map(one => one.argv[0])).toEqual(['wslview', 'xdg-open'])
  })
})
