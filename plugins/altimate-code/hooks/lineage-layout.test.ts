import { expect, test } from 'claude-code/testing'

import type { ColumnReachView } from '../types'
import { buildGraph, type Segment } from './lineage-graph'
import { drawLayered, drawStack, endsView, foldersView, graphView, type Layered } from './lineage-layout'

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
  const view = graphView(graph, FCT, { up: 2, down: 1, capUp: 0, capDown: 0 })
  expect(names(view)).toEqual([['stg_a', 'stg_b'], ['mid'], ['fct'], ['m1', 'm2', 'm3', 'm4', 'm5']])
  expect(view.layers[2]![0]!.kind).toBe('focus')
  expect(view.edges).toContainEqual(['model.shop.mid', FCT])
  expect(view.edges).toHaveLength(2 + 1 + 5)
  const deep = graphView(graph, FCT, { up: 3, down: 2, capUp: 0, capDown: 0 })
  expect(names(deep)[0]).toEqual(['orders'])
  expect(names(deep).at(-1)).toEqual(['m6', '◆ Dash'])
  expect(deep.layers.flat().some(box => box.label === 't1')).toBe(false)
})

test('graphView folds past the cap into one more box with the shared folder', () => {
  const view = graphView(graph, FCT, { up: 1, down: 1, capUp: 2, capDown: 2 })
  const last = view.layers.at(-1)!
  expect(last.map(box => box.label)).toEqual(['m1', 'm2', '+3 more · marts'])
  const more = last.at(-1)!
  expect(more).toEqual({ key: 'more:2', label: '+3 more · marts', kind: 'more' })
  expect(view.edges.filter(([, to]) => to === 'more:2')).toEqual([[FCT, 'more:2']])
})

test('graphView does not fold a single leftover and says no folder when they differ', () => {
  expect(graphView(graph, FCT, { up: 1, down: 1, capUp: 4, capDown: 4 }).layers.at(-1)).toHaveLength(5)
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
  expect(graphView(mixed, 'model.shop.f', { up: 1, down: 0, capUp: 1, capDown: 1 }).layers[0]!.map(box => box.label)).toEqual(['x1', '+2 more'])
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
  const view = graphView(wide, 'model.shop.f', { up: 2, down: 0, capUp: 0, capDown: 0 })
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
  const view = graphView(graph, FCT, { up: 1, down: 1, capUp: 2, capDown: 2, reach })
  const last = view.layers.at(-1)!
  expect(last.map(box => [box.label, box.tone])).toEqual([
    ['m3', 'maybe'],
    ['m5', 'hit'],
    ['+3 more · marts', 'dim'],
  ])
  expect(view.layers[0]!.every(box => box.tone === undefined)).toBe(true)
  expect(graphView(graph, FCT, { up: 1, down: 1, capUp: 0, capDown: 0 }).layers.flat().every(box => box.tone === undefined)).toBe(true)
})

test('endsView lists the roots and leaves with the models between', () => {
  const view = endsView(graph, FCT, { capUp: 0, capDown: 0 })
  // Sources and dashboards first, then the farthest ends.
  expect(names(view)).toEqual([['orders · via 2', 'stg_b · via 1'], ['fct'], ['◆ Dash · via 1', 'm6 · via 1', 'm3', 'm4', 'm5']])
  expect(view.edges).toHaveLength(2 + 5)
  expect(view.edges).toContainEqual([FCT, 'exposure.shop.dash'])
})

test('endsView folds ends past the cap', () => {
  const view = endsView(graph, FCT, { capUp: 2, capDown: 2 })
  expect(view.layers.at(-1)!.map(box => box.label)).toEqual(['◆ Dash · via 1', 'm6 · via 1', '+3 more · marts'])
  expect(view.edges.filter(([, to]) => to === 'more:2')).toEqual([[FCT, 'more:2']])
})

test('foldersView groups by folder and side', () => {
  const view = foldersView(graph, FCT)
  expect(names(view)).toEqual([['sources (1)'], ['staging (2)'], ['intermediate (1)'], ['fct'], ['marts (6) · 2 levels'], ['dashboards (1)']])
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
  const view = graphView(chain('a', 'b', 'c'), 'model.shop.b', { up: 1, down: 1, capUp: 0, capDown: 0 })
  const drawn = drawLayered(view, 120)
  expect(drawn.hidden).toBe(0)
  expect(text(drawn.rows)).toEqual([
    '┌───┐       ┏━━━┓       ┌───┐',
    '│ a ├──────▶┃ b ┠──────▶│ c │',
    '└───┘       ┗━━━┛       └───┘',
  ])
})

test('drawLayered joins a fork and a merge with junctions; lines into one box share a channel', () => {
  const rows = text(drawLayered(graphView(graph, FCT, { up: 2, down: 1, capUp: 0, capDown: 0 }), 200).rows).join('\n')
  for (const joint of ['├', '┐', '└', '┌', '┼']) expect(rows).toContain(joint)
  // stg_a and stg_b both feed mid: one vertical line, so no ┴ where two channels would meet.
  expect(rows).not.toContain('┴')
  expect(rows.split('▶').length - 1).toBe(7)
  for (const row of text(drawLayered(graphView(graph, FCT, { up: 1, down: 1, capUp: 0, capDown: 0 }), 200).rows)) {
    for (const at of [...row].map((ch, i) => (ch === '▶' ? i : -1)).filter(i => i >= 0)) expect(['│', '┃']).toContain([...row][at + 1])
  }
})

test('drawLayered drops far layers to fit and narrows a single layer', () => {
  const view = graphView(graph, FCT, { up: 2, down: 2, capUp: 0, capDown: 0 })
  const full = drawLayered(view, 500)
  expect(full.hidden).toBe(0)
  const narrow = drawLayered(view, 40)
  expect(narrow.hidden).toBeGreaterThan(0)
  expect(Math.max(...text(narrow.rows).map(row => [...row].length))).toBeLessThanOrEqual(40)
  const long = chain('a_rather_long_model_name_for_a_box', 'b')
  const tight = drawLayered(graphView(long, 'model.shop.b', { up: 1, down: 0, capUp: 0, capDown: 0 }), 40)
  expect(tight.hidden).toBe(0)
  expect(text(tight.rows)[1]).toContain('…')
  expect(Math.max(...text(tight.rows).map(row => [...row].length))).toBeLessThanOrEqual(40)
})

test('drawLayered label cells carry the node and styles', () => {
  const reach: ColumnReachView = { model: 'fct', column: 'x', models: [{ name: 'm1', columns: [] }], exposures: [], uncertainExposures: [], uncertain: [], untraced: [], truncated: false }
  const { rows } = drawLayered(graphView(graph, FCT, { up: 1, down: 1, capUp: 2, capDown: 2, reach }), 200)
  const segments = rows.flat()
  expect(segments.find(one => one.node === FCT)).toEqual({ text: expect.stringContaining('fct'), node: FCT, color: 'suggestion', bold: true })
  expect(segments.find(one => one.node === 'model.shop.m1')).toMatchObject({ color: 'warning', bold: true })
  expect(segments.find(one => one.node === 'model.shop.m2')).toMatchObject({ dim: true })
  expect(segments.filter(one => one.node === undefined && /[┌│└─]/.test(one.text)).length).toBeGreaterThan(0)
  expect(segments.filter(one => one.text.includes('more')).every(one => one.node === undefined && one.dim)).toBe(true)
})

test('endsView marks an upstream end with a prefix only when the ancestry was cut, and never a source', () => {
  const cut = endsView({ ...graph, upTruncated: true }, FCT, { capUp: 0, capDown: 0 })
  expect(names(cut)[0]).toEqual(['orders · via 2', '⋯ stg_b · via 1'])
  expect(names(endsView(graph, FCT, { capUp: 0, capDown: 0 }))[0]).toEqual(['orders · via 2', 'stg_b · via 1'])
})

test('an exposure takes its tone from the reach, and a more box the strongest of what it folds', () => {
  const reach: ColumnReachView = {
    model: 'fct',
    column: 'x',
    models: [],
    exposures: ['Dash'],
    uncertainExposures: [],
    uncertain: [
      { name: 'm4', reason: '' },
      { name: 'm5', reason: '' },
    ],
    untraced: [],
    truncated: false,
  }
  const view = graphView(graph, FCT, { up: 1, down: 2, capUp: 0, capDown: 1, reach })
  const exposure = view.layers.flat().find(box => box.kind === 'exposure')!
  expect(exposure.tone).toBe('hit')
  const first = view.layers[2]!
  expect(first.at(-1)).toMatchObject({ kind: 'more', tone: 'maybe' })
  const maybe = graphView(graph, FCT, { up: 1, down: 2, capUp: 0, capDown: 1, reach: { ...reach, exposures: [], uncertainExposures: ['Dash'] } })
  expect(maybe.layers.flat().find(box => box.kind === 'exposure')!.tone).toBe('maybe')
  const quiet = graphView(graph, FCT, { up: 1, down: 1, capUp: 0, capDown: 1, reach: { ...reach, uncertain: [] } })
  expect(quiet.layers.at(-1)!.at(-1)!.tone).toBe('dim')
})

test('foldersView orders groups by the group graph and marks truncated counts', () => {
  const dbt = buildGraph({
    nodes: {
      'model.shop.s1': model('s1', ['source.shop.raw.orders'], 'staging'),
      'model.shop.i1': model('i1', ['s1'], 'intermediate'),
      'model.shop.f': model('f', ['i1']),
      'model.shop.di': model('di', ['f'], 'intermediate'),
      'model.shop.dm': model('dm', ['di'], 'marts'),
    },
    sources: { 'source.shop.raw.orders': { resource_type: 'source', name: 'orders', original_file_path: 'models/staging/src.yml', depends_on: { nodes: [] } } },
    exposures: { 'exposure.shop.d': { resource_type: 'exposure', name: 'd', depends_on: { nodes: ['model.shop.dm'] } } },
  } as any)
  expect(names(foldersView(dbt, 'model.shop.f'))).toEqual([
    ['sources (1)'],
    ['staging (1)'],
    ['intermediate (1)'],
    ['f'],
    ['intermediate (1)'],
    ['marts (1)'],
    ['dashboards (1)'],
  ])
  const counted = names(foldersView({ ...dbt, truncated: true, upTruncated: true }, 'model.shop.f')).flat()
  expect(counted).toContain('staging (1+)')
  expect(counted).toContain('marts (1+)')
  expect(names(foldersView({ ...dbt, truncated: true }, 'model.shop.f')).flat()).toEqual(expect.arrayContaining(['staging (1)', 'marts (1+)']))
})

test("foldersView falls back to dbt's layer order when folders feed each other", () => {
  const loop = buildGraph({
    nodes: {
      'model.shop.a1': model('a1', [], 'intermediate'),
      'model.shop.b1': model('b1', ['a1'], 'marts'),
      'model.shop.a2': model('a2', ['b1'], 'intermediate'),
      'model.shop.f': model('f', ['a2']),
    },
    sources: {},
    exposures: {},
  } as any)
  const view = foldersView(loop, 'model.shop.f')
  expect(names(view)).toEqual([['intermediate (2) · 3 levels'], ['marts (1)'], ['f']])
})

test('drawLayered cuts a long label in the middle and keeps look-alike names apart', () => {
  const one = buildGraph({
    nodes: {
      'model.shop.int_query_tag_daily': model('int_query_tag_daily', []),
      'model.shop.int_query_user_daily': model('int_query_user_daily', []),
      'model.shop.f': model('f', ['int_query_tag_daily', 'int_query_user_daily']),
    },
    sources: {},
    exposures: {},
  } as any)
  const out = text(drawLayered(graphView(one, 'model.shop.f', { up: 1, down: 0, capUp: 0, capDown: 0 }), 30).rows).join('\n')
  expect(out).toContain('int_…tag_daily')
  expect(out).toContain('int_…ser_daily')
  const long = chain('first_long_model_name_ending_daily', 'second_long_model_name_ending_daily')
  const view = graphView(long, 'model.shop.second_long_model_name_ending_daily', { up: 1, down: 0, capUp: 0, capDown: 0 })
  view.layers[0]![0]!.label = '◆ a_very_long_dashboard_name_here · via 3'
  const shown = text(drawLayered(view, 80).rows)[1]!
  expect(shown).toMatch(/◆ a_ve….*name_here · via 3/)
})

test('drawLayered gives every source in a gap its own channel', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `p${i}`)
  const many = buildGraph({
    nodes: {
      ...Object.fromEntries(ids.map(one => [`model.shop.${one}`, model(one, [])])),
      'model.shop.c1': model('c1', ids),
      'model.shop.c2': model('c2', ids.slice(0, 4)),
      'model.shop.f': model('f', ['c1', 'c2']),
    },
    sources: {},
    exposures: {},
  } as any)
  const view = graphView(many, 'model.shop.c1', { up: 1, down: 0, capUp: 0, capDown: 0 })
  const rows = text(drawLayered(view, 200).rows)
  const arrows = rows.flatMap(row => [...row].flatMap((ch, i) => (ch === '▶' ? [i] : [])))
  expect(arrows).toHaveLength(1)
  const wide = graphView(many, 'model.shop.f', { up: 2, down: 0, capUp: 0, capDown: 0 })
  const lines = text(drawLayered(wide, 300).rows)
  // 8 sources into 2 boxes: eight vertical channels, none shared, so the gap is 10 wide.
  const gap = lines.map(row => [...row]).find(row => row.includes('▶'))!
  const channelCols = new Set<number>()
  for (const row of lines.map(one => [...one])) row.forEach((ch, i) => (['┐', '┘', '┤'].includes(ch) ? channelCols.add(i) : undefined))
  expect(gap.length).toBeGreaterThan(0)
  expect(channelCols.size).toBeGreaterThanOrEqual(8)
  for (const row of lines) {
    const chars = [...row]
    chars.forEach((ch, i) => ch === '▶' && expect(['│', '┃', '┠']).toContain(chars[i + 1]))
  }
})

test('drawStack stacks the folders top to bottom with an arrow between, and wraps a layer past the width', () => {
  const rows = text(drawStack(foldersView(graph, FCT), 40))
  const at = (label: string) => rows.findIndex(row => row.includes(label))
  expect(at('sources (1)')).toBeLessThan(at('staging (2)'))
  expect(at('staging (2)')).toBeLessThan(at('┃ fct'))
  expect(at('┃ fct')).toBeLessThan(at('marts (6) · 2 levels'))
  expect(rows.filter(row => row.trim() === '▼')).toHaveLength(5)
  const wide: Layered = { layers: [[1, 2, 3].map(i => ({ key: `g${i}`, label: `folder_${i} (9)`, kind: 'group' as const }))], edges: [] }
  const wrapped = text(drawStack(wide, 40))
  expect(wrapped).toHaveLength(6)
  expect(Math.max(...wrapped.map(row => row.length))).toBeLessThanOrEqual(40)
})

// Every unbroken run from a box's right border to an arrow must be a real link.
function straightRuns(rows: string[]): [string, string][] {
  const runs: [string, string][] = []
  for (const row of rows) {
    const chars = [...row]
    chars.forEach((ch, at) => {
      if (ch !== '▶') return
      // Junctions that carry the line on (┬ ┴ ┼) keep it one line to the eye.
      let x = at - 1
      while (x >= 0 && '─┬┴┼'.includes(chars[x]!)) x--
      if (x < 1 || !['├', '┠'].includes(chars[x]!) || chars[x - 1] !== ' ') return
      const from = chars.slice(0, x).join('').split(/[│┃]/).at(-1)!.trim()
      if (!from) return
      const to = chars.slice(at + 2).join('').split(/[│┃├┠]/)[0]!.trim()
      runs.push([from, to])
    })
  }
  return runs
}

const linksOf = (pairs: [string, string][]): LineageGraph => {
  const g: LineageGraph = { nodes: {}, parents: {}, children: {} }
  for (const name of new Set(pairs.flat())) {
    g.nodes[name] = { id: name, name, label: null, type: 'model', path: null, materialized: null, relation: null, columns: [] }
    g.parents[name] = []
    g.children[name] = []
  }
  for (const [a, b] of pairs) {
    g.children[a]!.push(b)
    g.parents[b]!.push(a)
  }
  return g
}

test('drawLayered never draws an unbroken line between two models that are not linked', () => {
  const cases: [string, [string, string][]][] = [
    // A folded layer pins "+N more" last, pulling lines across the rows of other sources.
    ['f', [['f', 'p1'], ['f', 'p2'], ['f', 'p3'], ['p1', 'x1'], ['p1', 'x2'], ['p3', 't1'], ['p3', 't2'], ['p3', 't3'], ['p3', 't4'], ['t1', 'u1'], ['t2', 'u2'], ['t3', 'u3'], ['t4', 'u4']]],
    // A barycenter tie puts a target on another source's row.
    ['f', [['f', 'a'], ['f', 'b'], ['f', 'c'], ['f', 'd'], ['a', 't1'], ['d', 't1'], ['b', 't2'], ['c', 't2']]],
  ]
  for (const [focus, pairs] of cases) {
    const graph = linksOf(pairs)
    const drawn = text(drawLayered(graphView(graph, focus, { up: 0, down: 3, capUp: 4, capDown: 4 }), 300).rows)
    const real = new Set(pairs.map(([a, b]) => `${a}>${b}`))
    for (const [from, to] of straightRuns(drawn)) {
      if (to.startsWith('+')) continue
      expect(real.has(`${from}>${to}`) || `${from}>${to}`).toBe(true)
    }
  }
})
