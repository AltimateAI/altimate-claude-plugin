import { describe, expect, test } from 'claude-code/testing'
import { graphLayout as layoutOf, pressIsClick } from './report-graph'
import { type ColumnAnswer, type ModelChange, reportData, reportHtml } from './impact-report'

type Layout = {
  boxes: { id: string; layer: number; x: number; y: number; h: number; name: string; title: string; collapsed?: boolean; count?: number; rows: { key: string }[] }[]
  edges: { from: string; to: string; keys: string[][]; label: string | null }[]
}
const graphLayout = layoutOf as (focus: unknown, levels: { up: number; down: number }, expanded: Record<number, boolean>) => Layout

const node = (name: string) => ({ id: `model.shop.${name}`, name, folder: 'marts', materialized: 'table', contract: false, tests: 0, exposures: [] })

/** fct.revenue read by `first` models one hop down, each read by the model `second` names, if any. */
function answer(first: string[], second: Record<string, string> = {}): ColumnAnswer {
  const names = ['fct', ...first, ...Object.values(second)]
  const nodes = names.map(node)
  const columns: any[] = [{ model: 0, column: 'revenue', hop: 0 }]
  const edges: any[] = []
  first.forEach(name => {
    columns.push({ model: names.indexOf(name), column: 'revenue', hop: 1 })
    edges.push([0, columns.length - 1, '='])
  })
  for (const [from, to] of Object.entries(second)) {
    columns.push({ model: names.indexOf(to), column: 'total', hop: 2, end: true })
    edges.push([1 + first.indexOf(from), columns.length - 1, 'Σ'])
  }
  return {
    version: 1,
    focus: { model: 'model.shop.fct', column: 'revenue' },
    direction: 'downstream',
    counts: { columns: columns.length - 1, models: names.length - 1, hops: 2, contracts: 0, ends: 1, may_carry_models: 0, cleared_models: 0, model_level: names.length - 1 },
    nodes,
    columns,
    edges,
  } as ColumnAnswer
}
const UP = {
  version: 1,
  focus: { model: 'model.shop.fct', column: 'revenue' },
  direction: 'upstream',
  nodes: [node('fct'), node('stg_orders'), { ...node('orders'), id: 'source.shop.raw.orders' }],
  columns: [
    { model: 0, column: 'revenue', hop: 0 },
    { model: 1, column: 'amount', hop: 1 },
    { model: 2, column: 'amount_cents', hop: 2, end: true },
  ],
  edges: [
    [1, 0, '~'],
    [2, 1, 'ƒ'],
  ],
} as ColumnAnswer
const CHANGE: ModelChange = { model: 'fct', file: 'models/fct.sql', root: '/repo', columns: [{ name: 'revenue', before: 'amount as revenue', after: 'amount * 1.1 as revenue' }] }
const TASK = { finishedAt: '2026-01-01 00:00 UTC', builtAt: '2026-01-01 00:05 UTC', manifest: 'the manifest', movedOn: [] as string[] }
const focusOf = (down: ColumnAnswer, up: ColumnAnswer | null = UP) =>
  reportData([CHANGE], [{ model: 'fct', column: 'revenue', down, up, modelLevel: null, failed: false }], TASK).focuses[0]
const layer = (lay: Layout, n: number) => lay.boxes.filter(box => box.layer === n)

describe('report graph layout', () => {
  test('upstream sits left of the changed column and downstream right, one layer per hop shown', () => {
    const lay = graphLayout(focusOf(answer(['a', 'b'], { a: 'x' })), { up: 2, down: 2 }, {})
    expect(layer(lay, 0).map(box => box.name)).toEqual(['fct'])
    expect(layer(lay, 0)[0]!.x).toBe(0)
    expect(layer(lay, 1).every(box => box.x > 0)).toBe(true)
    expect(layer(lay, 2).every(box => box.x > layer(lay, 1)[0]!.x)).toBe(true)
    expect(layer(lay, -1).map(box => box.name)).toEqual(['stg_orders'])
    expect(layer(lay, -2).every(box => box.x < layer(lay, -1)[0]!.x)).toBe(true)
    const fewer = graphLayout(focusOf(answer(['a', 'b'], { a: 'x' })), { up: 1, down: 1 }, {})
    expect([...new Set(fewer.boxes.map(box => box.layer))].sort()).toEqual([-1, 0, 1])
    expect(fewer.edges.map(edge => `${edge.from}>${edge.to}`).sort()).toEqual([
      'model.shop.fct|revenue>model.shop.a|revenue',
      'model.shop.fct|revenue>model.shop.b|revenue',
      'model.shop.stg_orders|amount>model.shop.fct|revenue',
    ])
  })

  test('a level of more than 12 models is one box, with one edge into it, until it is expanded', () => {
    const many = Array.from({ length: 20 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const focus = focusOf(answer(many))
    const folded = graphLayout(focus, { up: 2, down: 2 }, {})
    expect(layer(folded, 1).map(box => [box.name, box.collapsed, box.count])).toEqual([['+20 models', true, 20]])
    const into = folded.edges.filter(edge => edge.from === 'model.shop.fct|revenue')
    expect(into.length).toBe(1)
    expect(into[0]!.keys.length).toBe(20)
    const open = graphLayout(focus, { up: 2, down: 2 }, { 1: true })
    expect(layer(open, 1).length).toBe(20)
    expect(open.edges.filter(edge => edge.from === 'model.shop.fct|revenue').length).toBe(20)
  })

  test("orders a layer by where its edges come from, whatever the data's order", () => {
    // a above b by name; z reads a and y reads b, so z sits above y although y comes first by name.
    const down = answer(['a', 'b'], { a: 'z', b: 'y' })
    const lay = graphLayout(focusOf(down), { up: 2, down: 2 }, {})
    expect(layer(lay, 1).map(box => box.name)).toEqual(['a', 'b'])
    expect(layer(lay, 2).map(box => box.name)).toEqual(['z', 'y'])
    const shuffled = { ...down, nodes: [...down.nodes!].reverse(), columns: down.columns!.map(c => ({ ...c, model: down.nodes!.length - 1 - c.model })) }
    expect(graphLayout(focusOf(shuffled as ColumnAnswer), { up: 2, down: 2 }, {})).toEqual(lay)
  })

  test("labels an edge with how the value changes, and leaves one the engine couldn't tell unlabelled", () => {
    const down = answer(['a', 'b'], { a: 'x' })
    down.edges = down.edges!.map((edge, i) => (i === 1 ? [edge[0], edge[1], '?'] : i === 2 ? [edge[0], edge[1]] : edge))
    const up = { ...UP, edges: [[1, 0, '~'], [2, 1, 'ƒ']] } as ColumnAnswer
    const labels = Object.fromEntries(graphLayout(focusOf(down, up), { up: 2, down: 2 }, {}).edges.map(edge => [`${edge.from.split('|')[0]!.split('.').pop()}>${edge.to.split('|')[0]!.split('.').pop()}`, edge.label]))
    // a: same; b: unknown; x: no derivation given; upstream: renamed and calculated.
    expect(labels).toEqual({ 'fct>a': '=', 'fct>b': null, 'a>x': null, 'stg_orders>fct': '~', 'orders>stg_orders': 'ƒ' })
    const agg = answer(['a'], { a: 'x' })
    expect(graphLayout(focusOf(agg), { up: 2, down: 2 }, {}).edges.find(edge => edge.to.startsWith('model.shop.x'))!.label).toBe('Σ')
  })

  test('cuts a long model name and keeps the whole name in its title', () => {
    const long = 'int_query_cost_attribution_by_warehouse_and_hour'
    const box = layer(graphLayout(focusOf(answer([long])), { up: 0, down: 1 }, {}), 1)[0]!
    expect(box.name).toBe(`${long.slice(0, 27)}…`)
    expect(box.title.startsWith(long)).toBe(true)
  })
})

describe('a press on the graph', () => {
  const row = 'row:model.shop.fct|revenue'
  test('on a column, released on it a few pixels away, is a click: a hand drifts while clicking', () => {
    expect(pressIsClick({ x: 100, y: 50, target: row }, { x: 100, y: 50, target: row })).toBe(true)
    expect(pressIsClick({ x: 100, y: 50, target: row }, { x: 103, y: 52, target: row })).toBe(true)
    expect(pressIsClick({ x: 100, y: 50, target: row }, { x: 93, y: 42, target: row })).toBe(true)
    expect(pressIsClick({ x: 100, y: 50, target: 'box:2' }, { x: 106, y: 46, target: 'box:2' })).toBe(true)
  })

  test('that moves further, ends on something else, or starts on the canvas is a drag', () => {
    expect(pressIsClick({ x: 100, y: 50, target: row }, { x: 113, y: 50, target: row })).toBe(false)
    expect(pressIsClick({ x: 100, y: 50, target: row }, { x: 102, y: 51, target: 'row:model.shop.a|revenue' })).toBe(false)
    expect(pressIsClick({ x: 100, y: 50, target: row }, { x: 101, y: 50, target: null })).toBe(false)
    expect(pressIsClick({ x: 100, y: 50, target: null }, { x: 100, y: 50, target: null })).toBe(false)
  })

  test('the page decides a pointer click at its release, and a column\'s own click event only serves the keyboard and scripts', () => {
    const html = reportHtml(reportData([CHANGE], [{ model: 'fct', column: 'revenue', down: answer(['a']), up: UP, modelLevel: null, failed: false }], TASK))
    expect(html).toContain('function pressIsClick(')
    expect(html).toContain('ok=pressIsClick(press,{x:ev.clientX,y:ev.clientY,target:targetOf(document.elementFromPoint(ev.clientX,ev.clientY))})')
    expect(html).toContain("row.addEventListener('click',function(ev){ev.stopPropagation();if(tookPress)return;select(r.key)})")
    expect(html).not.toContain('if(moved)return;ev.stopPropagation()')
  })
})

describe('report page', () => {
  test('allows only its own inline script and style, and carries the graph', () => {
    const html = reportHtml(reportData([CHANGE], [{ model: 'fct', column: 'revenue', down: answer(['a']), up: UP, modelLevel: null, failed: false }], TASK))
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">`)
    expect(html).toContain('function graphLayout(')
    expect(html).toContain('function graphPanel(')
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet|@import|url\(http/)
  })

  test('says what an unlabelled edge means, and draws a label only for an edge that has one', () => {
    const html = reportHtml(reportData([CHANGE], [{ model: 'fct', column: 'revenue', down: answer(['a']), up: UP, modelLevel: null, failed: false }], TASK))
    expect(html).toContain('Dashed, unlabelled: the engine couldn\u2019t tell how the value changes.')
    expect(html).toContain("if(e.label)g.appendChild(sv('text'")
  })
})
