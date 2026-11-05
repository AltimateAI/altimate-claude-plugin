import { describe, expect, test } from 'claude-code/testing'

import {
  answerOf,
  changedColumns,
  type ColumnAnswer,
  type ColumnTrace,
  DEFAULT_LEVELS,
  type ModelChange,
  openerFor,
  reachOf,
  reportData,
  reportHtml,
  sectionOf,
  summaryLines,
  summaryOf,
} from './impact-report'

// A synthetic project: orders → fct_orders.revenue → three hops of readers.
export const DOWN: ColumnAnswer = {
  version: 1,
  focus: { model: 'model.shop.fct_orders', column: 'revenue' },
  direction: 'downstream',
  inputs: { manifest: { generated_at: '2026-01-01', older_than_sql: false }, sql: 'compiled_code', catalog: null, engine: 'core 1.0', workarounds: [] },
  counts: { columns: 4, models: 3, hops: 3, contracts: 1, ends: 2, may_carry_models: 1, cleared_models: 2, model_level: 6 },
  nodes: [
    { id: 'model.shop.fct_orders', name: 'fct_orders', folder: 'marts', materialized: 'table', contract: false, tests: 1, exposures: [] },
    { id: 'model.shop.fct_revenue_daily', name: 'fct_revenue_daily', folder: 'marts', materialized: 'table', contract: true, tests: 2, exposures: ['exec_revenue'] },
    { id: 'model.shop.rpt_finance', name: 'rpt_finance', folder: 'reports', materialized: 'view', contract: false, tests: 0, exposures: [] },
    { id: 'model.shop.rpt_board', name: 'rpt_board', folder: 'reports', materialized: 'view', contract: false, tests: 0, exposures: [] },
    { id: 'model.shop.rpt_misc', name: 'rpt_misc', folder: 'reports', materialized: 'view', contract: false, tests: 0, exposures: [] },
    { id: 'model.shop.rpt_broken', name: 'rpt_broken', folder: 'reports', materialized: 'view', contract: false, tests: 0, exposures: [] },
  ],
  columns: [
    { model: 0, column: 'revenue', hop: 0 },
    { model: 1, column: 'daily_revenue', hop: 1, type: 'number' },
    { model: 1, column: 'revenue', hop: 1, end: true, how: '=', how_from: 'name' },
    { model: 2, column: 'weekly_revenue', hop: 2 },
    { model: 3, column: 'board_revenue', hop: 3, end: true },
  ],
  edges: [
    [0, 1, 'Σ'],
    [0, 2, '='],
    [1, 3, 'ƒ'],
    [3, 4, '~'],
  ],
  also_reads: [{ model: 4, columns: ['revenue'], downstream: 2 }],
  unresolved: [{ model: 5, reason: 'parse error' }],
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
    { model: 0, column: 'revenue', hop: 0 },
    { model: 1, column: 'amount', hop: 1 },
    { model: 2, column: 'amount_cents', hop: 2, end: true },
  ],
  edges: [
    [1, 0, 'Σ'],
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
    expect(reachOf(DOWN)).toEqual({ columns: 4, models: 3, ends: 2, hops: 3, mayCarry: 1, cleared: 2, unresolved: 1, modelLevel: 6, truncated: false })
    const bare = { ...DOWN, counts: undefined }
    expect(reachOf(bare)).toEqual({ columns: 4, models: 3, ends: 2, hops: 3, mayCarry: 1, cleared: null, unresolved: 1, modelLevel: null, truncated: false })
  })
})

describe('the summary', () => {
  test('names each changed column with its how and its reach, and says the reach is a lower bound', () => {
    const lines = summaryLines(summaryOf([CHANGE], [TRACE], '/repo/target/.altimate-lineage/report.html'))
    expect(lines).toEqual([
      '◆ Lineage after this task · 1 model changed',
      'fct_orders · 6 downstream models at model level',
      '  revenue Σ  reaches 4 columns in 3 models (2 ends) · 1 may carry it · 2 cleared',
      '⚠ Lower bound: 1 model could not be read',
    ])
  })

  test('a model with no changed output column shows its model-level count alone', () => {
    const change = { ...CHANGE, columns: [] }
    const lines = summaryLines(summaryOf([change], [{ model: 'fct_orders', column: null, down: null, up: null, modelLevel: 6, failed: false }], null))
    expect(lines).toEqual(['◆ Lineage after this task · 1 model changed', 'fct_orders · 6 downstream models at model level', '  no output column changed: the model-level count stands'])
  })
})

describe('the report', () => {
  test('groups downstream by hop then model, with the how per column, ends and contracts', () => {
    const down = sectionOf(DOWN)
    expect(down.hops.map(one => one.hop)).toEqual([1, 2, 3])
    const daily = down.hops[0]!.models[0]!
    expect(daily).toMatchObject({ name: 'fct_revenue_daily', contract: true, tests: 2, exposures: ['exec_revenue'] })
    expect(daily.columns.map(one => [one.column, one.glyph, one.byName, one.end])).toEqual([
      ['daily_revenue', 'Σ', false, false],
      ['revenue', '=', true, true],
    ])
    // Upstream: how each column feeds the one below it.
    expect(sectionOf(UP).hops.map(one => one.models[0]!.columns[0]!.glyph)).toEqual(['Σ', 'ƒ'])
  })

  test('embeds both directions with edges keyed by model and column, folds, and two levels by default', () => {
    const html = reportHtml(reportData([CHANGE], [TRACE], '2026-01-01 00:00 UTC', 'the manifest as it was when the task started'))
    expect(html).toContain('data-levels="2"')
    const data = embedded(html)
    expect(data.defaultLevels).toBe(DEFAULT_LEVELS)
    expect(DEFAULT_LEVELS).toBe(2)
    const focus = data.focuses[0]
    expect(focus).toMatchObject({ model: 'fct_orders', column: 'revenue', key: 'model.shop.fct_orders|revenue', glyph: 'Σ', before: 'sum(amount) as revenue' })
    expect(focus.up.hops.map((one: any) => one.hop)).toEqual([1, 2])
    expect(focus.down.hops.map((one: any) => one.hop)).toEqual([1, 2, 3])
    // The highlight walks these edges both ways from the clicked column.
    expect(focus.edges).toContainEqual(['model.shop.int_orders|amount', 'model.shop.fct_orders|revenue', 'Σ'])
    expect(focus.edges).toContainEqual(['model.shop.rpt_finance|weekly_revenue', 'model.shop.rpt_board|board_revenue', '~'])
    expect(focus.alsoReads).toEqual([{ name: 'rpt_misc', columns: ['revenue'], downstream: 2 }])
    expect(focus.unresolved).toEqual([{ name: 'rpt_broken', reason: 'parse error', downstream: null }])
    expect(focus.cleared).toEqual({ names: [], count: 2 })
    expect(data.changes[0].columns[0].after).toBe('sum(amount) - sum(refunds) as revenue')
  })

  test('is one offline file: no external resource, and project text cannot close its script', () => {
    const hostile = { ...CHANGE, model: 'x</script><script>alert(1)</script>' }
    const html = reportHtml(reportData([hostile], [{ ...TRACE, model: hostile.model }], 'now', 'm'))
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//)
    expect(html).not.toContain('<script>alert(1)')
    expect(html.match(/<\/script>/g)!.length).toBe(2)
    expect(embedded(html).changes[0].model).toBe(hostile.model)
    expect(html).toContain('prefers-color-scheme:dark')
  })
})

describe('the opener', () => {
  test('per platform: open, xdg-open, wslview or explorer.exe on the Windows path, start', () => {
    const path = '/repo/target/.altimate-lineage/report.html'
    expect(openerFor('mac', path)).toEqual({ argv: ['open', path], okExits: [0] })
    expect(openerFor('linux', path)).toEqual({ argv: ['xdg-open', path], okExits: [0] })
    expect(openerFor('wsl', path, { wslview: true })).toEqual({ argv: ['wslview', path], okExits: [0] })
    // explorer.exe exits 1 even when it opened the file.
    expect(openerFor('wsl', path, { wslview: false, windowsPath: '\\\\wsl.localhost\\x\\report.html' })).toEqual({
      argv: ['explorer.exe', '\\\\wsl.localhost\\x\\report.html'],
      okExits: [0, 1],
    })
    expect(openerFor('wsl', path, { wslview: false, windowsPath: null })).toBeNull()
    expect(openerFor('windows', path)).toEqual({ argv: ['cmd', '/c', 'start', '', path], okExits: [0] })
  })
})
