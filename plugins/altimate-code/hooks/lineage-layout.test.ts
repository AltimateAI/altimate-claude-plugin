import { expect, test } from 'claude-code/testing'

import type { ColumnReachView } from '../types'
import { buildGraph, type Segment } from './lineage-graph'
import { drawLayered, endsView, foldersView, graphView, type Layered } from './lineage-layout'

const model = (name: string, deps: string[], folder = 'marts') => ({
  resource_type: 'model',
  name,
  original_file_path: `models/${folder}/${name}.sql`,
  depends_on: { nodes: deps.map(dep => (dep.includes('.') ? dep : `model.shop.${dep}`)) },
  columns: {},
})

const manifest = {
  nodes: {
    'model.shop.stg_a': model('stg_a', ['source.shop.raw.orders'], 'staging'),
    'model.shop.stg_b': model('stg_b', [], 'staging'),
    'model.shop.mid': model('mid', ['stg_a', 'stg_b'], 'intermediate'),
    'model.shop.fct': model('fct', ['mid'], 'marts'),
    'model.shop.m1': model('m1', ['fct']),
    'model.shop.m2': model('m2', ['fct']),
    'model.shop.m3': model('m3', ['fct']),
    'model.shop.m4': model('m4', ['fct']),
    'model.shop.m5': model('m5', ['fct']),
    'model.shop.m6': model('m6', ['m1']),
    'test.shop.t1': { resource_type: 'test', name: 't1', depends_on: { nodes: ['model.shop.fct'] } },
  },
  sources: { 'source.shop.raw.orders': { resource_type: 'source', name: 'orders', original_file_path: 'models/staging/src.yml', depends_on: { nodes: [] } } },
  exposures: { 'exposure.shop.dash': { resource_type: 'exposure', name: 'dash', label: 'Dash', depends_on: { nodes: ['model.shop.m2'] } } },
}
const graph = buildGraph(manifest as any)
const FCT = 'model.shop.fct'

const names = (view: Layered) => view.layers.map(layer => layer.map(box => box.label))
const text = (rows: Segment[][]) => rows.map(row => row.map(one => one.text).join(''))

const chain = (...ids: string[]) =>
  buildGraph({ nodes: Object.fromEntries(ids.map((id, i) => [`model.shop.${id}`, model(id, i === 0 ? [] : [ids[i - 1]!])])), sources: {}, exposures: {} } as any)

test('graphView layers by distance and skips tests', () => {
  const view = graphView(graph, FCT, { up: 2, down: 1, cap: 0 })
  expect(names(view)).toEqual([['stg_a', 'stg_b'], ['mid'], ['fct'], ['m1', 'm2', 'm3', 'm4', 'm5']])
  expect(view.layers[2]![0]!.kind).toBe('focus')
  expect(view.edges).toContainEqual(['model.shop.mid', FCT])
  expect(view.edges).toHaveLength(2 + 1 + 5)
  const deep = graphView(graph, FCT, { up: 3, down: 2, cap: 0 })
  expect(names(deep)[0]).toEqual(['orders'])
  expect(names(deep).at(-1)).toEqual(['m6', '◆ Dash'])
  expect(deep.layers.flat().some(box => box.label === 't1')).toBe(false)
})

test('graphView folds past the cap into one more box with the shared folder', () => {
  const view = graphView(graph, FCT, { up: 1, down: 1, cap: 2 })
  const last = view.layers.at(-1)!
  expect(last.map(box => box.label)).toEqual(['m1', 'm2', '+3 more · marts'])
  const more = last.at(-1)!
  expect(more).toEqual({ key: 'more:2', label: '+3 more · marts', kind: 'more' })
  expect(view.edges.filter(([, to]) => to === 'more:2')).toEqual([[FCT, 'more:2']])
})

test('graphView does not fold a single leftover and says no folder when they differ', () => {
  expect(graphView(graph, FCT, { up: 1, down: 1, cap: 4 }).layers.at(-1)).toHaveLength(5)
  const mixed = buildGraph({
    nodes: {
      'model.shop.x1': model('x1', [], 'staging'),
      'model.shop.x2': model('x2', [], 'staging'),
      'model.shop.x3': model('x3', [], 'raw'),
      'model.shop.f': model('f', ['x1', 'x2', 'x3']),
    },
    sources: {},
    exposures: {},
  } as any)
  expect(graphView(mixed, 'model.shop.f', { up: 1, down: 0, cap: 1 }).layers[0]!.map(box => box.label)).toEqual(['x1', '+2 more'])
})

test('graphView orders boxes by their neighbours nearer the focus', () => {
  const wide = buildGraph({
    nodes: {
      'model.shop.a': model('a', []),
      'model.shop.b': model('b', []),
      'model.shop.p1': model('p1', ['b']),
      'model.shop.p2': model('p2', ['a']),
      'model.shop.f': model('f', ['p1', 'p2']),
    },
    sources: {},
    exposures: {},
  } as any)
  const view = graphView(wide, 'model.shop.f', { up: 2, down: 0, cap: 0 })
  expect(names(view)).toEqual([['b', 'a'], ['p1', 'p2'], ['f']])
})

test('graphView keeps reach hits when capping and sets tones', () => {
  const reach: ColumnReachView = {
    model: 'fct',
    column: 'x',
    models: [{ name: 'm5', id: 'model.shop.m5', columns: [] }],
    exposures: [],
    uncertainExposures: [],
    uncertain: [{ name: 'm3', reason: '' }],
    untraced: [],
    truncated: false,
  }
  const view = graphView(graph, FCT, { up: 1, down: 1, cap: 2, reach })
  const last = view.layers.at(-1)!
  expect(last.map(box => [box.label, box.tone])).toEqual([
    ['m3', 'maybe'],
    ['m5', 'hit'],
    ['+3 more · marts', 'dim'],
  ])
  expect(view.layers[0]!.every(box => box.tone === undefined)).toBe(true)
  expect(graphView(graph, FCT, { up: 1, down: 1, cap: 0 }).layers.flat().every(box => box.tone === undefined)).toBe(true)
})

test('endsView lists the roots and leaves with the models between', () => {
  const view = endsView(graph, FCT, { cap: 0 })
  expect(names(view)).toEqual([['⋯ stg_b · via 1', 'orders · via 2'], ['fct'], ['◆ Dash · via 1', 'm3', 'm4', 'm5', 'm6 · via 1']])
  expect(view.edges).toHaveLength(2 + 5)
  expect(view.edges).toContainEqual([FCT, 'exposure.shop.dash'])
})

test('endsView folds ends past the cap', () => {
  const view = endsView(graph, FCT, { cap: 2 })
  expect(view.layers.at(-1)!.map(box => box.label)).toEqual(['◆ Dash · via 1', 'm3', '+3 more · marts'])
  expect(view.edges.filter(([, to]) => to === 'more:2')).toEqual([[FCT, 'more:2']])
})

test('foldersView groups by folder and side', () => {
  const view = foldersView(graph, FCT)
  expect(names(view)).toEqual([['sources (1)'], ['staging (2)'], ['intermediate (1)'], ['fct'], ['marts (6)'], ['dashboards (1)']])
  expect(view.layers[4]!.map(box => box.key)).toEqual(['group:down:marts'])
  expect(view.edges).toEqual(
    expect.arrayContaining([
      ['group:up:staging', 'group:up:intermediate'],
      ['group:up:intermediate', FCT],
      [FCT, 'group:down:marts'],
      ['group:down:marts', 'group:down:dashboards'],
    ]),
  )
})

test('drawLayered draws a three-model chain', () => {
  const view = graphView(chain('a', 'b', 'c'), 'model.shop.b', { up: 1, down: 1, cap: 0 })
  const drawn = drawLayered(view, 120)
  expect(drawn.hidden).toBe(0)
  expect(text(drawn.rows)).toEqual([
    '┌───┐       ┏━━━┓       ┌───┐',
    '│ a ├──────▶┃ b ┠──────▶│ c │',
    '└───┘       ┗━━━┛       └───┘',
  ])
})

test('drawLayered joins a fork and a merge with junctions; lines into one box share a channel', () => {
  const rows = text(drawLayered(graphView(graph, FCT, { up: 2, down: 1, cap: 0 }), 200).rows).join('\n')
  for (const joint of ['├', '┐', '└', '┌', '┼']) expect(rows).toContain(joint)
  // stg_a and stg_b both feed mid: one vertical line, so no ┴ where two channels would meet.
  expect(rows).not.toContain('┴')
  expect(rows.split('▶').length - 1).toBe(7)
  for (const row of text(drawLayered(graphView(graph, FCT, { up: 1, down: 1, cap: 0 }), 200).rows)) {
    for (const at of [...row].map((ch, i) => (ch === '▶' ? i : -1)).filter(i => i >= 0)) expect(['│', '┃']).toContain([...row][at + 1])
  }
})

test('drawLayered drops far layers to fit and narrows a single layer', () => {
  const view = graphView(graph, FCT, { up: 2, down: 2, cap: 0 })
  const full = drawLayered(view, 500)
  expect(full.hidden).toBe(0)
  const narrow = drawLayered(view, 40)
  expect(narrow.hidden).toBeGreaterThan(0)
  expect(Math.max(...text(narrow.rows).map(row => [...row].length))).toBeLessThanOrEqual(40)
  const long = chain('a_rather_long_model_name_for_a_box', 'b')
  const tight = drawLayered(graphView(long, 'model.shop.b', { up: 1, down: 0, cap: 0 }), 40)
  expect(tight.hidden).toBe(0)
  expect(text(tight.rows)[1]).toContain('…')
  expect(Math.max(...text(tight.rows).map(row => [...row].length))).toBeLessThanOrEqual(40)
})

test('drawLayered label cells carry the node and styles', () => {
  const reach: ColumnReachView = { model: 'fct', column: 'x', models: [{ name: 'm1', columns: [] }], exposures: [], uncertainExposures: [], uncertain: [], untraced: [], truncated: false }
  const { rows } = drawLayered(graphView(graph, FCT, { up: 1, down: 1, cap: 2, reach }), 200)
  const segments = rows.flat()
  expect(segments.find(one => one.node === FCT)).toEqual({ text: expect.stringContaining('fct'), node: FCT, color: 'suggestion', bold: true })
  expect(segments.find(one => one.node === 'model.shop.m1')).toMatchObject({ color: 'warning', bold: true })
  expect(segments.find(one => one.node === 'model.shop.m2')).toMatchObject({ dim: true })
  expect(segments.filter(one => one.node === undefined && /[┌│└─]/.test(one.text)).length).toBeGreaterThan(0)
  expect(segments.filter(one => one.text.includes('more')).every(one => one.node === undefined && one.dim)).toBe(true)
})
