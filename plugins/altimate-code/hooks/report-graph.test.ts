import { describe, expect, test } from 'claude-code/testing'
import { graphLayout as layoutOf, graphView, pressIsClick } from './report-graph'
import { type ColumnAnswer, type ModelChange, reportData, reportHtml } from './impact-report'

type Layout = {
  boxes: { id: string; layer: number; x: number; y: number; h: number; name: string; title: string; badge?: string; model?: string; collapsed?: boolean; count?: number; rows: { key: string }[] }[]
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
    counts: { columns: columns.length - 1, models: names.length - 1, hops: 2, contracts: 0, ends: 1, may_carry_models: 0, model_level: names.length - 1 },
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

  test("cuts a name shorter when the box carries a badge, so the two don't run into each other", () => {
    const long = 'mrt_tableau_dashboard_cost_attribution'
    const down = answer([long, 'plain'])
    down.nodes[1] = { ...down.nodes[1]!, contract: true, exposures: ['exec', 'ops'] }
    down.flags = [{ model: 1, flag: 'filter_rewritten' }]
    const boxes = layer(graphLayout(focusOf(down), { up: 0, down: 1 }, {}), 1)
    const marked = boxes.find(box => box.title.startsWith(long))!
    expect(marked.badge).toBe('C \u25a32 !')
    // 28 characters less the badge and a space.
    expect(marked.name).toBe(`${long.slice(0, 20)}…`)
    expect(boxes.find(box => box.title.startsWith('plain'))!.badge).toBe('')
  })

  test('lists its boxes in reading order, left to right then top to bottom, which is the order Tab takes', () => {
    const lay = graphLayout(focusOf(answer(['a', 'b'], { a: 'x', b: 'y' })), { up: 2, down: 2 }, {})
    expect(lay.boxes.map(box => box.name)).toEqual(['orders', 'stg_orders', 'fct', 'a', 'b', 'x', 'y'])
    // A column read out to the keyboard names its model too: many models share a column name.
    expect(lay.boxes.map(box => box.model)).toEqual(['orders', 'stg_orders', 'fct', 'a', 'b', 'x', 'y'])
    expect(lay.boxes.every((box, i) => i === 0 || lay.boxes[i - 1]!.layer < box.layer || (lay.boxes[i - 1]!.layer === box.layer && lay.boxes[i - 1]!.y < box.y))).toBe(true)
  })
})

describe('the first view of the graph', () => {
  const bounds = { x: -656, y: -100, w: 1640, h: 200 }
  const focus = { x: 118, y: 0 }
  test('shows the whole graph when it fits at a readable zoom, and never zooms past 1', () => {
    expect(graphView({ w: 990, h: 600 }, bounds, focus, false)).toEqual({ k: (990 - 32) / 1640, x: 495 - (bounds.x + 820) * ((990 - 32) / 1640), y: 300 })
    expect(graphView({ w: 990, h: 600 }, { x: 0, y: 0, w: 236, h: 50 }, focus, false).k).toBe(1)
  })

  test('in a narrow panel, starts on the changed column at 0.7, where the whole graph would be unreadable', () => {
    const narrow = graphView({ w: 398, h: 600 }, bounds, focus, false)
    expect(narrow).toEqual({ k: 0.7, x: 199 - focus.x * 0.7, y: 300 })
    // A wide panel only steps in below 0.35.
    expect(graphView({ w: 990, h: 600 }, { ...bounds, w: 4000 }, focus, false).k).toBe(0.35)
    // Fit always shows the whole graph.
    expect(graphView({ w: 398, h: 600 }, bounds, focus, true).k).toBe((398 - 32) / 1640)
  })

  test('the page runs the same function, and a column reached by Tab is brought into the panel', () => {
    const html = reportHtml(reportData([CHANGE], [{ model: 'fct', column: 'revenue', down: answer(['a']), up: UP, modelLevel: null, failed: false }], TASK))
    expect(html).toContain('function graphView(')
    expect(html).toContain('v=graphView(size(),lay.bounds,lay.focus,force)')
    expect(html).toContain("row.addEventListener('focus',function(){if(!row.matches(':focus-visible'))return;")
    expect(html).toContain("'aria-label':r.title+' in '+b.model+': light up its path'")
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
