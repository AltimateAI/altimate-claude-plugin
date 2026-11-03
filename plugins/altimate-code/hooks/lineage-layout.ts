import type { ColumnReachView, GraphNode, LineageGraph } from '../types'
import type { Segment } from './lineage-graph'

export type ViewKind = 'graph' | 'ends' | 'folders'
export type LayoutBox = {
  key: string
  label: string
  node?: string
  kind: 'focus' | 'model' | 'exposure' | 'more' | 'group'
  tone?: 'hit' | 'maybe' | 'dim'
}
/** Boxes in columns, farthest upstream first, and the edges between box keys, parent to child. */
export type Layered = { layers: LayoutBox[][]; edges: [string, string][] }

const isTestId = (graph: LineageGraph, id: string) => ['test', 'unit_test'].includes(graph.nodes[id]?.type ?? id.split('.')[0] ?? '')

const nodeOf = (graph: LineageGraph, id: string): GraphNode =>
  graph.nodes[id] ?? { id, name: id.split('.').pop() ?? id, label: null, type: id.split('.')[0] ?? '', path: null, materialized: null, relation: null, columns: [] }

/** Breadth-first distance from `id` along parents or children; tests are skipped, `limit` levels at most. */
function walk(graph: LineageGraph, id: string, side: 'parents' | 'children', limit: number): Map<string, number> {
  const dist = new Map<string, number>()
  const seen = new Set([id])
  let frontier = [id]
  for (let depth = 1; depth <= limit && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const one of frontier) {
      for (const other of graph[side][one] ?? []) {
        if (seen.has(other) || isTestId(graph, other)) continue
        seen.add(other)
        dist.set(other, depth)
        next.push(other)
      }
    }
    frontier = next
  }
  return dist
}

const boxOf = (graph: LineageGraph, id: string, focus: string): LayoutBox => {
  const node = nodeOf(graph, id)
  if (id === focus) return { key: id, label: node.name, node: id, kind: 'focus' }
  if (node.type === 'exposure') return { key: id, label: `◆ ${node.label ?? node.name}`, node: id, kind: 'exposure' }
  return { key: id, label: node.name, node: id, kind: 'model' }
}

/** `marts` for `models/marts/x.sql`: the folder a model file sits in under its top-level directory. */
const subfolder = (node: GraphNode) => {
  if (!['model', 'seed', 'snapshot'].includes(node.type)) return null
  const parts = (node.path ?? '').split('/')
  return parts.length >= 3 ? parts[1]! : null
}

/**
 * Keeps the first `cap` boxes of a priority-ordered layer and folds the rest into one `more` box.
 * One folded box would take the room of its own box, so a single leftover is kept as it is.
 */
function capLayer(graph: LineageGraph, ranked: LayoutBox[], cap: number, index: number): { boxes: LayoutBox[]; folded: Map<string, string> } {
  const folded = new Map<string, string>()
  if (!(cap > 0) || !Number.isFinite(cap) || ranked.length <= cap + 1) return { boxes: ranked, folded }
  const kept = ranked.slice(0, cap)
  const rest = ranked.slice(cap)
  const folders = new Set(rest.map(box => (box.node ? subfolder(nodeOf(graph, box.node)) : null)))
  const common = folders.size === 1 ? [...folders][0] : null
  const key = `more:${index}`
  for (const box of rest) folded.set(box.key, key)
  return { boxes: [...kept, { key, label: `+${rest.length} more${common ? ` · ${common}` : ''}`, kind: 'more' }], folded }
}

const dedupe = (edges: [string, string][]) => {
  const seen = new Set<string>()
  return edges.filter(([from, to]) => {
    const one = `${from}\0${to}`
    if (from === to || seen.has(one)) return false
    seen.add(one)
    return true
  })
}

type Matcher = (node: GraphNode) => 'hit' | 'maybe' | undefined

function reachMatcher(reach: ColumnReachView | null | undefined): Matcher | null {
  if (!reach) return null
  const same = (node: GraphNode) => (one: { name: string; id?: string }) => (one.id ? one.id === node.id : one.name === node.name)
  return node => {
    if (reach.models.some(same(node))) return 'hit'
    if (reach.uncertain.some(same(node)) || reach.untraced.some(same(node))) return 'maybe'
    return undefined
  }
}

/**
 * Orders each layer by the mean position of the boxes it connects to in the layer nearer the focus,
 * sweeping outward twice; boxes with no such neighbour and ties keep their place, `more` boxes stay last.
 */
function orderLayers(layers: LayoutBox[][], edges: [string, string][], focusIndex: number) {
  const order = [
    ...Array.from({ length: focusIndex }, (_, i) => focusIndex - 1 - i),
    ...Array.from({ length: layers.length - focusIndex - 1 }, (_, i) => focusIndex + 1 + i),
  ]
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const index of order) {
      const near = layers[index < focusIndex ? index + 1 : index - 1]!
      const position = new Map(near.map((box, at) => [box.key, at]))
      const bary = new Map<string, number>()
      layers[index]!.forEach((box, at) => {
        const linked = edges
          .map(([from, to]) => (index < focusIndex ? (from === box.key ? to : null) : to === box.key ? from : null))
          .filter((key): key is string => key !== null && position.has(key))
        bary.set(box.key, linked.length > 0 ? linked.reduce((sum, key) => sum + position.get(key)!, 0) / linked.length : at)
      })
      const at = new Map(layers[index]!.map((box, i) => [box.key, i]))
      layers[index] = [...layers[index]!].sort((a, b) => {
        if ((a.kind === 'more') !== (b.kind === 'more')) return a.kind === 'more' ? 1 : -1
        return bary.get(a.key)! - bary.get(b.key)! || at.get(a.key)! - at.get(b.key)!
      })
    }
  }
}

/**
 * The focus with `up` layers before it and `down` after, by distance. Only edges between adjacent
 * layers are drawn: a node that is also a parent of something two layers on has no line to it.
 */
export function graphView(graph: LineageGraph, id: string, opts: { up: number; down: number; cap: number; reach?: ColumnReachView | null }): Layered {
  const upDist = walk(graph, id, 'parents', opts.up)
  const downDist = walk(graph, id, 'children', opts.down)
  const maxUp = Math.max(0, ...upDist.values())
  const maxDown = Math.max(0, ...downDist.values())
  const layerIds: string[][] = [
    ...Array.from({ length: maxUp }, (_, i) => [...upDist].filter(([, d]) => d === maxUp - i).map(([one]) => one)),
    [id],
    ...Array.from({ length: maxDown }, (_, i) => [...downDist].filter(([, d]) => d === i + 1).map(([one]) => one)),
  ]
  const layerOf = new Map<string, number>()
  layerIds.forEach((ids, index) => ids.forEach(one => layerOf.set(one, index)))
  const focusIndex = maxUp

  const rawEdges: [string, string][] = []
  for (const [child, index] of layerOf) {
    for (const parent of graph.parents[child] ?? []) if (layerOf.get(parent) === index - 1) rawEdges.push([parent, child])
  }

  const matcher = reachMatcher(opts.reach)
  const priority = (one: string) => {
    const node = nodeOf(graph, one)
    if (matcher?.(node)) return 0
    return node.type === 'exposure' ? 1 : 2
  }
  // How many shown nodes lie beyond a node, away from the focus.
  const beyond = (one: string, index: number) => {
    const next = index < focusIndex ? graph.parents : graph.children
    const seen = new Set<string>()
    const stack = [one]
    while (stack.length > 0) {
      for (const other of next[stack.pop()!] ?? []) {
        if (seen.has(other) || !layerOf.has(other)) continue
        seen.add(other)
        stack.push(other)
      }
    }
    return seen.size
  }

  const folded = new Map<string, string>()
  const layers = layerIds.map((ids, index) => {
    if (index === focusIndex) return [boxOf(graph, id, id)]
    const ranked = ids.map((one, at) => ({ one, at, p: priority(one), n: beyond(one, index) })).sort((a, b) => a.p - b.p || b.n - a.n || a.at - b.at)
    const capped = capLayer(graph, ranked.map(entry => boxOf(graph, entry.one, id)), opts.cap, index)
    for (const [from, to] of capped.folded) folded.set(from, to)
    return capped.boxes
  })
  const edges = dedupe(rawEdges.map(([from, to]) => [folded.get(from) ?? from, folded.get(to) ?? to]))
  orderLayers(layers, edges, focusIndex)

  if (matcher) {
    layers.forEach((boxes, index) => {
      if (index === focusIndex) return
      for (const box of boxes) {
        const hit = box.node ? matcher(nodeOf(graph, box.node)) : undefined
        if (hit) box.tone = hit
        else if (index > focusIndex) box.tone = 'dim'
      }
    })
  }
  return { layers, edges }
}

/** Upstream roots, the focus and downstream leaves, each end labelled with how many models sit between. */
export function endsView(graph: LineageGraph, id: string, opts: { cap: number }): Layered {
  const label = (box: LayoutBox, via: number) => (via > 0 ? { ...box, label: `${box.label} · via ${via}` } : box)
  const priority = (box: LayoutBox) => (box.kind === 'exposure' ? 0 : 1)
  const ends = (side: 'parents' | 'children') => {
    const dist = walk(graph, id, side, Infinity)
    const boxes = [...dist]
      .filter(([one]) => (graph[side][one] ?? []).every(other => isTestId(graph, other)))
      .map(([one, d]) => {
        const box = label(boxOf(graph, one, id), d - 1)
        // The pane keeps two levels upstream, so a model at that edge has parents of its own: ⋯ says so.
        const cut = side === 'parents' && !['source', 'seed'].includes(graph.nodes[one]?.type ?? '')
        return cut ? { ...box, label: `⋯ ${box.label}` } : box
      })
    return boxes.sort((a, b) => priority(a) - priority(b))
  }
  const ups = ends('parents')
  const downs = ends('children')
  const upLayer = ups.length > 0 ? capLayer(graph, ups, opts.cap, 0) : null
  const downLayer = downs.length > 0 ? capLayer(graph, downs, opts.cap, upLayer ? 2 : 1) : null
  const focus = boxOf(graph, id, id)
  const layers = [upLayer?.boxes, [focus], downLayer?.boxes].filter((one): one is LayoutBox[] => !!one)
  const edges: [string, string][] = []
  for (const box of upLayer?.boxes ?? []) edges.push([box.key, id])
  for (const box of downLayer?.boxes ?? []) edges.push([id, box.key])
  return { layers, edges }
}

const folderOf = (node: GraphNode) => {
  if (node.type === 'source') return 'sources'
  if (node.type === 'exposure') return 'dashboards'
  const parts = (node.path ?? '').split('/')
  return parts.length >= 3 ? parts[1]! : parts[0] || 'other'
}

/** Everything but the focus folded into one box per folder and side, so a big project reads as a few boxes. */
export function foldersView(graph: LineageGraph, id: string): Layered {
  type Group = { key: string; folder: string; count: number; dist: number; side: 'up' | 'down' }
  const groups = new Map<string, Group>()
  const groupOf = new Map<string, string>()
  for (const side of ['up', 'down'] as const) {
    for (const [one, d] of walk(graph, id, side === 'up' ? 'parents' : 'children', Infinity)) {
      const folder = folderOf(nodeOf(graph, one))
      const key = `group:${side}:${folder}`
      const group = groups.get(key) ?? { key, folder, count: 0, dist: d, side }
      group.count++
      group.dist = Math.min(group.dist, d)
      groups.set(key, group)
      groupOf.set(one, key)
    }
  }
  const column = (side: 'up' | 'down') => {
    const mine = [...groups.values()].filter(group => group.side === side)
    const dists = [...new Set(mine.map(group => group.dist))].sort((a, b) => (side === 'up' ? b - a : a - b))
    return dists.map(d =>
      mine
        .filter(group => group.dist === d)
        .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder))
        .map((group): LayoutBox => ({ key: group.key, label: `${group.folder} (${group.count})`, kind: 'group' })),
    )
  }
  const layers = [...column('up'), [boxOf(graph, id, id)], ...column('down')]
  const layerOf = new Map<string, number>()
  layers.forEach((boxes, index) => boxes.forEach(box => layerOf.set(box.key, index)))
  const keyOf = (one: string) => (one === id ? id : groupOf.get(one))
  const raw: [string, string][] = []
  for (const [child, parents] of Object.entries(graph.parents)) {
    for (const parent of parents) {
      const from = keyOf(parent)
      const to = keyOf(child)
      if (from && to && layerOf.get(from)! < layerOf.get(to)!) raw.push([from, to])
    }
  }
  return { layers, edges: dedupe(raw) }
}

const GAP = 7
const MAX_BOX = 28
// Boxes narrow to this before a layer is dropped: dbt names past it read poorly.
const DROP_BOX = 16
const MIN_BOX = 12
// Gap columns 1..5 carry a vertical channel; column 0 leaves the box and column 6 holds the arrow.
const CHANNELS = 5
const N = 1
const E = 2
const S = 4
const W = 8
const JOINT = [' ', '│', '─', '└', '│', '│', '┌', '├', '─', '┘', '─', '┴', '┐', '┤', '┬', '┼']

type Style = { color?: string; dim?: boolean; bold?: boolean }
type Cell = { ch: string; node?: string; style?: Style }

const styleOf = (box: LayoutBox): Style => {
  if (box.kind === 'focus') return { color: 'suggestion', bold: true }
  if (box.tone === 'hit') return { color: 'warning', bold: true }
  if (box.tone === 'maybe') return { color: 'warning' }
  if (box.tone === 'dim' || box.kind === 'more' || box.kind === 'group') return { dim: true }
  if (box.kind === 'exposure') return { color: 'warning' }
  return {}
}

const sameStyle = (a: Cell, b: Cell) =>
  a.node === b.node && a.style?.color === b.style?.color && !!a.style?.dim === !!b.style?.dim && !!a.style?.bold === !!b.style?.bold

type Placed = { x: number; y: number; w: number; layer: number }

function place(layers: LayoutBox[][], cap: number) {
  const widths = layers.map(boxes => Math.min(cap, Math.max(0, ...boxes.map(box => box.label.length)) + 4))
  const heights = layers.map(boxes => boxes.length * 4 - 1)
  const total = Math.max(0, ...heights)
  const width = widths.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, layers.length - 1)
  const spots = new Map<string, Placed>()
  let x = 0
  layers.forEach((boxes, layer) => {
    const top = Math.floor((total - heights[layer]!) / 2)
    boxes.forEach((box, i) => spots.set(box.key, { x, y: top + i * 4, w: widths[layer]!, layer }))
    x += widths[layer]! + GAP
  })
  return { spots, width, height: total }
}

/**
 * Draws the layers as boxes joined by right-angled lines. Boxes narrow first; layers that still do
 * not fit `maxWidth` are dropped, counted in `hidden`: upstream past the first level, then the farthest
 * downstream and upstream in turn. One layer that is still too wide has its boxes narrowed further.
 */
export function drawLayered(view: Layered, maxWidth: number): { rows: Segment[][]; hidden: number } {
  let layers = view.layers
  let hidden = 0
  const focusAt = Math.max(0, layers.findIndex(boxes => boxes.some(box => box.kind === 'focus')))
  let before = focusAt
  let dropDown = true
  const widthOf = (list: LayoutBox[][]) => place(list, DROP_BOX).width
  while (layers.length > 1 && widthOf(layers) > maxWidth) {
    const after = layers.length - before - 1
    const alternate = before <= 1
    const upstream = before > 1 || after === 0 || (!dropDown && before > 0)
    if (upstream) {
      layers = layers.slice(1)
      before--
    } else layers = layers.slice(0, -1)
    if (alternate) dropDown = !dropDown
    hidden++
  }
  let cap = MAX_BOX
  while (cap > MIN_BOX && place(layers, cap).width > maxWidth) cap--

  const { spots, width, height } = place(layers, cap)
  if (layers.length === 0) return { rows: [], hidden }
  const cells: (Cell | null)[][] = Array.from({ length: height }, () => Array<Cell | null>(width).fill(null))
  const mask: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(0))

  const linked = new Set<string>()
  const gaps = new Map<number, Map<string, string[]>>()
  for (const [from, to] of view.edges) {
    const a = spots.get(from)
    const b = spots.get(to)
    if (!a || !b || b.layer !== a.layer + 1) continue
    const byFrom = gaps.get(a.layer) ?? new Map<string, string[]>()
    byFrom.set(from, [...(byFrom.get(from) ?? []), to])
    gaps.set(a.layer, byFrom)
  }
  const dim: Style = { dim: true }
  const h = (x1: number, x2: number, y: number) => {
    for (let x = x1; x < x2; x++) {
      mask[y]![x]! |= E
      mask[y]![x + 1]! |= W
    }
  }
  for (const byFrom of gaps.values()) {
    // Each source gets its own channel. Sources whose lines run down are ordered top first and the rest bottom first,
    // and the first get the rightmost channels, so the lines of one do not cut the horizontal run of the next.
    const rowOf = (from: string) => spots.get(from)!.y + 1
    const goesDown = (from: string) => byFrom.get(from)!.reduce((sum, to) => sum + spots.get(to)!.y + 1 - rowOf(from), 0) >= 0
    const sources = [...byFrom.keys()]
    const downs = sources.filter(goesDown).sort((p, q) => rowOf(p) - rowOf(q))
    const ups = sources.filter(from => !goesDown(from)).sort((p, q) => rowOf(q) - rowOf(p))
    const first = Math.min(CHANNELS, sources.length + 2)
    // Lines that all end on one box merge into one channel: a shared line cannot be misread there.
    const oneTarget = new Set([...byFrom.values()].flat()).size === 1
    ;[...downs, ...ups].forEach((from, index) => {
      const a = spots.get(from)!
      const channel = oneTarget ? Math.ceil(CHANNELS / 2) : first - (index % first)
      const ys = a.y + 1
      const targets = byFrom.get(from)!
      linked.add(from)
      const rows = targets.map(to => spots.get(to)!.y + 1)
      const x0 = a.x + a.w
      const column = x0 + channel
      for (const [i, to] of targets.entries()) {
        const yt = rows[i]!
        if (yt === ys) {
          h(x0, x0 + 5, ys)
        } else {
          h(x0, column, ys)
          h(column, x0 + 5, yt)
        }
        mask[yt]![x0 + 5]! |= E
        const b = spots.get(to)!
        cells[yt]![b.x - 1] = { ch: '▶', style: dim }
      }
      const lo = Math.min(ys, ...rows)
      const hi = Math.max(ys, ...rows)
      for (let y = lo; y < hi; y++) {
        mask[y]![column]! |= S
        mask[y + 1]![column]! |= N
      }
    })
  }

  for (const boxes of layers) {
    for (const box of boxes) {
      const { x, y, w } = spots.get(box.key)!
      const style = styleOf(box)
      const heavy = box.kind === 'focus'
      const [tl, tr, bl, br, hz, vt] = heavy ? ['┏', '┓', '┗', '┛', '━', '┃'] : ['┌', '┐', '└', '┘', '─', '│']
      const inner = w - 4
      const text = box.label.length > inner ? `${box.label.slice(0, Math.max(0, inner - 1))}…` : box.label
      const put = (cx: number, cy: number, ch: string, node?: string) => {
        cells[cy]![cx] = node ? { ch, node, style } : { ch, style }
      }
      put(x, y, tl)
      put(x + w - 1, y, tr)
      put(x, y + 2, bl)
      put(x + w - 1, y + 2, br)
      for (let i = 1; i < w - 1; i++) {
        put(x + i, y, hz)
        put(x + i, y + 2, hz)
      }
      put(x, y + 1, vt)
      put(x + w - 1, y + 1, linked.has(box.key) ? (vt === '┃' ? '┠' : '├') : vt)
      for (let i = 1; i < w - 1; i++) put(x + i, y + 1, i >= 2 && i - 2 < text.length ? text[i - 2]! : ' ', box.node)
    }
  }

  const rows = cells.map((line, y) => {
    const row = line.map((cell, x): Cell => cell ?? (mask[y]![x]! ? { ch: JOINT[mask[y]![x]!]!, style: dim } : { ch: ' ' }))
    while (row.length > 0 && row[row.length - 1]!.ch === ' ' && !row[row.length - 1]!.node) row.pop()
    if (row.length === 0) return [{ text: '' }]
    const out: Segment[] = []
    let last: Cell | null = null
    for (const cell of row) {
      if (last && sameStyle(last, cell)) out[out.length - 1]!.text += cell.ch
      else {
        const seg: Segment = { text: cell.ch }
        if (cell.node) seg.node = cell.node
        if (cell.style?.color) seg.color = cell.style.color
        if (cell.style?.dim) seg.dim = true
        if (cell.style?.bold) seg.bold = true
        out.push(seg)
      }
      last = cell
    }
    return out
  })
  return { rows, hidden }
}
