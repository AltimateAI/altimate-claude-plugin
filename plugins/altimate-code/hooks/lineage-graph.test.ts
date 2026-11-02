import { expect, test } from 'claude-code/testing'

import {
  buildGraph,
  columnsFromMetadata,
  downstreamArt,
  findModel,
  impactOf,
  parseDbtLineage,
  reachFromMetadata,
  type Segment,
  severityOf,
  subgraph,
  toSvg,
  touchedColumns,
  upstreamArt,
  warehouseEdges,
} from './lineage-graph'

const model = (name: string, deps: string[], extra: Record<string, unknown> = {}) => ({
  resource_type: 'model',
  name,
  original_file_path: `models/${name}.sql`,
  relation_name: `"shop"."main"."${name}"`,
  depends_on: { nodes: deps.map(dep => (dep.includes('.') ? dep : `model.shop.${dep}`)) },
  config: { materialized: 'view' },
  columns: {},
  ...extra,
})

export const MANIFEST = {
  nodes: {
    'model.shop.stg_orders': model('stg_orders', []),
    'model.shop.stg_payments': model('stg_payments', []),
    'model.shop.stg_refunds': model('stg_refunds', []),
    'model.shop.stg_customers': model('stg_customers', []),
    'model.shop.int_orders': model('int_orders', ['stg_orders', 'stg_payments', 'stg_refunds']),
    'model.shop.fct_orders': model('fct_orders', ['int_orders', 'stg_customers'], {
      config: { materialized: 'table' },
      columns: { order_id: { name: 'order_id' }, revenue: { name: 'revenue' }, gross_revenue: { name: 'gross_revenue' } },
    }),
    'model.shop.fct_revenue_daily': model('fct_revenue_daily', ['fct_orders']),
    'model.shop.mart_cohort_ltv': model('mart_cohort_ltv', ['fct_orders']),
    'model.shop.legacy_orders_v1': model('legacy_orders_v1', ['fct_orders']),
    'model.shop.rpt_a': model('rpt_a', ['fct_orders']),
    'model.shop.rpt_b': model('rpt_b', ['fct_orders']),
    'model.shop.rpt_finance_weekly': model('rpt_finance_weekly', ['fct_revenue_daily']),
    'test.shop.not_null_fct_orders_order_id': { resource_type: 'test', name: 'not_null', depends_on: { nodes: ['model.shop.fct_orders'] } },
  },
  sources: {},
  exposures: {
    'exposure.shop.exec_revenue': { resource_type: 'exposure', name: 'exec_revenue', label: 'Exec Revenue', depends_on: { nodes: ['model.shop.fct_revenue_daily'] } },
    'exposure.shop.cohort_ltv': { resource_type: 'exposure', name: 'cohort_ltv', label: 'Cohort LTV', depends_on: { nodes: ['model.shop.mart_cohort_ltv'] } },
  },
}

const text = (rows: Segment[][]) => rows.map(row => row.map(one => one.text).join('').trimEnd())

test('upstream brackets each parent’s parents into it, and the parents into the model', () => {
  const graph = buildGraph(MANIFEST)
  expect(text(upstreamArt(graph, 'model.shop.fct_orders'))).toEqual([
    'stg_orders   ─┐',
    'stg_payments ─┼─▶ int_orders    ─┬─▶ ■ fct_orders',
    'stg_refunds  ─┘                  │',
    '                  stg_customers ─┘',
  ])
  expect(text(upstreamArt(graph, 'model.shop.int_orders'))).toEqual([
    'stg_orders   ─┐',
    'stg_payments ─┼─▶ ■ int_orders',
    'stg_refunds  ─┘',
  ])
  expect(text(upstreamArt(graph, 'model.shop.stg_orders'))).toEqual(['no upstream nodes'])
})

test('downstream shows three children with what reads them, the rest folded until expanded', () => {
  const graph = buildGraph(MANIFEST)
  expect(text(downstreamArt(graph, 'model.shop.fct_orders'))).toEqual([
    '■ fct_orders ─▶ fct_revenue_daily ─▶ ◆ Exec Revenue, rpt_finance_weekly',
    '             ─▶ mart_cohort_ltv   ─▶ ◆ Cohort LTV',
    '             ─▶ legacy_orders_v1',
    '             ─▶ 2 more models',
  ])
  expect(downstreamArt(graph, 'model.shop.fct_orders', true)).toHaveLength(5)
  const exposure = downstreamArt(graph, 'model.shop.fct_orders')[0]!.find(one => one.text === '◆ Exec Revenue')
  expect(exposure?.color).toBe('suggestion')
  expect(text(downstreamArt(graph, 'model.shop.rpt_a'))).toEqual(['■ rpt_a nothing reads this model'])
})

test('impact counts over models and snapshots, with impact_analysis\' severity thresholds', () => {
  const graph = buildGraph(MANIFEST)
  expect(impactOf(graph, 'model.shop.fct_orders')).toEqual({
    direct: 5,
    transitive: 1,
    tests: 1,
    exposures: ['Exec Revenue', 'Cohort LTV'],
    severity: 'MEDIUM',
  })
  expect([0, 3, 4, 10, 11].map(severityOf)).toEqual(['SAFE', 'LOW', 'MEDIUM', 'MEDIUM', 'HIGH'])
})

test('a snapshot is followable like a model', () => {
  const graph = buildGraph({
    ...MANIFEST,
    nodes: { ...MANIFEST.nodes, 'snapshot.shop.snap': { ...model('snap', ['fct_orders']), resource_type: 'snapshot' } },
  })
  expect(findModel(graph, 'snapshot.shop.snap')).toBe('snapshot.shop.snap')
  expect(impactOf(graph, 'model.shop.fct_orders').direct).toBe(6)
})

test('dbt parent_map and child_map are used when present, and a model is found by path or name', () => {
  const graph = buildGraph({ ...MANIFEST, parent_map: { 'model.shop.fct_orders': [] }, child_map: { 'model.shop.fct_orders': ['model.shop.rpt_a'] } })
  expect(graph.children['model.shop.fct_orders']).toEqual(['model.shop.rpt_a'])
  expect(findModel(graph, 'models/fct_orders.sql')).toBe('model.shop.fct_orders')
  expect(findModel(graph, 'FCT_ORDERS')).toBe('model.shop.fct_orders')
  expect(findModel(graph, 'models/nope.sql')).toBeNull()
  expect(graph.nodes['model.shop.fct_orders']!.relation).toBe('shop.main.fct_orders')
})

test('the subgraph keeps two levels up, everything downstream and the tests', () => {
  const sub = subgraph(buildGraph(MANIFEST), 'model.shop.int_orders')
  expect(Object.keys(sub.nodes)).toContain('model.shop.rpt_finance_weekly')
  expect(Object.keys(sub.nodes)).toContain('exposure.shop.exec_revenue')
  expect(Object.keys(sub.nodes)).not.toContain('model.shop.stg_customers')
  expect(impactOf(sub, 'model.shop.int_orders').tests).toBe(1)
})

test('dbt_lineage text parses into the same columns as its structured metadata', () => {
  const edges = [
    { source: '"int_orders"."revenue"', target: 'revenue', lineage_type: 'direct', lens_type: 'Original', lens_code: [] },
    { source: '"int_orders"."gross_amount"', target: 'gross_revenue', lineage_type: 'direct', lens_type: 'Transformation', lens_code: [{ expression: 'gross_amount * 1.0', step_type: 'transform' }] },
    { source: '"int_orders"."status"', target: 'revenue', lineage_type: 'indirect', lens_type: 'Non select', lens_code: [] },
  ]
  const textOutput = [
    'Model: fct_orders',
    'ID: model.shop.fct_orders',
    '',
    'Column Mappings:',
    '  revenue ← ["\\"int_orders\\".\\"revenue\\""]',
    '  gross_revenue ← ["\\"int_orders\\".\\"gross_amount\\""]',
    '',
    'Lineage Edges:',
    ...edges.map(edge => `  ${JSON.stringify(edge)}`),
  ].join('\n')
  const parsed = parseDbtLineage(textOutput)
  expect(parsed.model).toBe('fct_orders')
  expect(parsed.confidence).toBe('high')
  expect(parsed.columns).toEqual([
    { name: 'revenue', sources: ['int_orders.revenue'] },
    { name: 'gross_revenue', sources: ['int_orders.gross_amount'] },
  ])
  expect(parsed.edges.map(edge => [edge.target, edge.lens, edge.lineageType, edge.expression])).toEqual([
    ['revenue', 'Original', 'direct', null],
    ['gross_revenue', 'Transformation', 'direct', 'gross_amount * 1.0'],
    ['revenue', 'Non select', 'indirect', null],
  ])
  const structured = columnsFromMetadata({
    model_name: 'fct_orders',
    confidence: 'high',
    confidence_factors: [],
    upstream: ['model.shop.int_orders'],
    columns: { revenue: ['"int_orders"."revenue"'], gross_revenue: ['"int_orders"."gross_amount"'] },
    edges,
  })!
  expect(structured.columns).toEqual(parsed.columns)
  expect(structured.upstream).toEqual(['model.shop.int_orders'])
  expect(parseDbtLineage('Model: x\n\nConfidence: low\n  Note: No compiled SQL found — run `dbt compile` first\n\nNo lineage data returned.')).toEqual({
    model: 'x',
    confidence: 'low',
    note: 'No compiled SQL found — run `dbt compile` first',
    upstream: [],
    columns: [],
    edges: [],
  })
  expect(columnsFromMetadata({ model_name: 'x', confidence: 'high' })).toBeNull()
})

test('column reach, warehouse records and edited columns read as the pane needs them', () => {
  expect(
    reachFromMetadata(
      { column_reach: { models: [{ name: 'fct_revenue_daily', columns: ['revenue'] }], exposures: [{ name: 'exec_revenue', label: 'Exec Revenue' }], truncated: false } },
      'fct_orders',
      'revenue',
    ),
  ).toEqual({
    model: 'fct_orders',
    column: 'revenue',
    models: [{ name: 'fct_revenue_daily', columns: ['revenue'] }],
    exposures: ['Exec Revenue'],
    uncertainExposures: [],
    uncertain: [],
    untraced: [],
    truncated: false,
  })
  expect(reachFromMetadata({ severity: 'LOW' }, 'fct_orders', 'revenue')).toBeNull()

  expect(
    warehouseEdges({ data: { records: [{ source_table: 'shop.main.fct_orders', target_table: 'shop.main.fct_revenue_daily', hop: 1 }, { nothing: true }] } }),
  ).toEqual([{ source: 'shop.main.fct_orders', target: 'shop.main.fct_revenue_daily', hop: 1 }])

  // The rewritten expression's column, not one that only sits on the same line unchanged, comes first.
  expect(
    touchedColumns(
      ['  i.revenue, i.gross_amount as gross_revenue\nfrom x'],
      ["  case when i.status = 'x' then 0 else i.revenue end as revenue, i.gross_amount as gross_revenue\nfrom x"],
      ['order_id', 'gross_revenue', 'revenue'],
    ),
  ).toEqual(['revenue', 'gross_revenue'])
  expect(touchedColumns(['sum(amount) as revenue'], ['sum(amount) - sum(refunds) as revenue'], ['order_id', 'revenue'])).toEqual(['revenue'])
  // A column only in unchanged context lines is not touched.
  expect(touchedColumns(['select order_id,\n  1 as a'], ['select order_id,\n  2 as a'], ['order_id'])).toEqual([])
})

test('the desktop SVG names every drawn node and escapes markup', () => {
  const svg = toSvg(buildGraph(MANIFEST), 'model.shop.fct_orders')
  for (const name of ['int_orders', 'stg_orders', 'fct_orders', 'fct_revenue_daily', '◆ Exec Revenue']) expect(svg).toContain(name)
  expect(svg.startsWith('<svg')).toBe(true)
  const tricky = buildGraph({ nodes: { 'model.s.a<b': model('a<b', []) }, sources: {}, exposures: {} })
  expect(toSvg(tricky, 'model.s.a<b')).toContain('a&lt;b')
})
