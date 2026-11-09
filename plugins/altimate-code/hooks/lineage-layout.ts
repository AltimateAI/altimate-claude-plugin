import type { ColumnReachView, GraphNode, LineageGraph } from '../types'
import { isTest, nodeOf as manifestNode, type Segment } from './lineage-graph'

export type ViewKind = 'graph' | 'ends' | 'folders'
export type LayoutBox = {
  key: string
  label: string
  node?: string
  kind: 'focus' | 'model' | 'exposure' | 'more' | 'group'
  tone?: 'hit' | 'maybe' | 'dim'
  /** A `+N more` box: the nodes it stands for. */
  folded?: string[]
}
/** Boxes in columns, farthest upstream first, and the edges between box keys, parent to child. */
export type Layered = { layers: LayoutBox[][]; edges: [string, string][] }

const isTestId = (graph: LineageGraph, id: string) => isTest(graph.nodes[id], id)

const nodeOf = (graph: LineageGraph, id: string): GraphNode => graph.nodes[id] ?? manifestNode(id, null)

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
function capLayer(graph: LineageGraph, ranked: LayoutBox[], cap: number, index: number, side: 'up' | 'down'): { boxes: LayoutBox[]; folded: Map<string, string> } {
  const folded = new Map<string, string>()
  if (!(cap > 0) || !Number.isFinite(cap) || ranked.length <= cap + 1) return { boxes: ranked, folded }
  const kept = ranked.slice(0, cap)
  const rest = ranked.slice(cap)
  const folders = new Set(rest.map(box => (box.node ? subfolder(nodeOf(graph, box.node)) : null)))
  const common = folders.size === 1 ? [...folders][0] : null
  const key = `more:${index}`
  for (const box of rest) folded.set(box.key, key)
  const hidden = rest.flatMap(box => box.folded ?? (box.node ? [box.node] : []))
  return { boxes: [...kept, { key, label: `+${rest.length} more${common ? ` · ${common}` : ''}`, node: `more:${side}`, kind: 'more', folded: hidden }], folded }
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
    if (node.type === 'exposure') {
      const name = node.label ?? node.name
      if (reach.exposures.includes(name)) return 'hit'
      return reach.uncertainExposures.includes(name) ? 'maybe' : undefined
    }
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
export function graphView(graph: LineageGraph, id: string, opts: { up: number; down: number; capUp: number; capDown: number; reach?: ColumnReachView | null }): Layered {
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
  // How much of the shown graph hangs beyond a node, away from the focus: paths, not distinct nodes, so
  // a diamond counts twice. Limit: an estimate for ranking, linear with the memo; exact counts cost O(N·E) per render.
  const memo = new Map<string, number>()
  const beyond = (one: string, index: number): number => {
    const known = memo.get(one)
    if (known !== undefined) return known
    memo.set(one, 0)
    const next = index < focusIndex ? graph.parents : graph.children
    let total = 0
    for (const other of next[one] ?? []) if (layerOf.has(other)) total += 1 + beyond(other, index)
    memo.set(one, Math.min(total, 1e9))
    return memo.get(one)!
  }

  const folded = new Map<string, string>()
  const layers = layerIds.map((ids, index) => {
    if (index === focusIndex) return [boxOf(graph, id, id)]
    const cap = index < focusIndex ? opts.capUp : opts.capDown
    // Ranking only matters when the layer folds.
    const folds = cap > 0 && Number.isFinite(cap) && ids.length > cap + 1
    const ranked = ids.map((one, at) => ({ one, at, p: priority(one), n: folds ? beyond(one, index) : 0 })).sort((a, b) => a.p - b.p || b.n - a.n || a.at - b.at)
    const capped = capLayer(graph, ranked.map(entry => boxOf(graph, entry.one, id)), cap, index, index < focusIndex ? 'up' : 'down')
    for (const [from, to] of capped.folded) folded.set(from, to)
    return capped.boxes
  })
  const edges = dedupe(rawEdges.map(([from, to]) => [folded.get(from) ?? from, folded.get(to) ?? to]))
  orderLayers(layers, edges, focusIndex)

  if (matcher) {
    layers.forEach((boxes, index) => {
      if (index === focusIndex) return
      for (const box of boxes) {
        const members = box.kind === 'more' ? [...folded].filter(([, to]) => to === box.key).map(([from]) => from) : box.node ? [box.node] : []
        const results = members.map(one => matcher(nodeOf(graph, one)))
        const hit = results.includes('hit') ? 'hit' : results.includes('maybe') ? 'maybe' : undefined
        if (hit) box.tone = hit
        else if (index > focusIndex) box.tone = 'dim'
      }
    })
  }
  return { layers, edges }
}

/** Upstream roots, the focus and downstream leaves, each end labelled with how many models sit between. */
export function endsView(graph: LineageGraph, id: string, opts: { capUp: number; capDown: number }): Layered {
  const label = (box: LayoutBox, via: number) => (via > 0 ? { ...box, label: `${box.label} · via ${via}` } : box)
  // Shown first: dashboards downstream, and sources, seeds and snapshots upstream (where the data
  // enters), then the farthest ends, so a long chain's true origins stay out of "+N more".
  const ORIGINS = ['source', 'seed', 'snapshot']
  const priority = (box: LayoutBox) => (box.kind === 'exposure' || ORIGINS.includes(graph.nodes[box.key]?.type ?? '') ? 0 : 1)
  const ends = (side: 'parents' | 'children') => {
    const dist = walk(graph, id, side, Infinity)
    const far = (box: LayoutBox) => dist.get(box.key) ?? 0
    const boxes = [...dist]
      .filter(([one]) => (graph[side][one] ?? []).every(other => isTestId(graph, other)))
      .map(([one, d]) => {
        const box = label(boxOf(graph, one, id), d - 1)
        // When the pane cut the ancestry short, a model at the edge has parents of its own: ⋯ says so.
        const cut = side === 'parents' && !!graph.upTruncated && !['source', 'seed'].includes(graph.nodes[one]?.type ?? '')
        return cut ? { ...box, label: `⋯ ${box.label}` } : box
      })
    return boxes.sort((a, b) => priority(a) - priority(b) || far(b) - far(a))
  }
  const ups = ends('parents')
  const downs = ends('children')
  const upLayer = ups.length > 0 ? capLayer(graph, ups, opts.capUp, 0, 'up') : null
  const downLayer = downs.length > 0 ? capLayer(graph, downs, opts.capDown, upLayer ? 2 : 1, 'down') : null
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

/**
 * Everything but the focus folded into one box per folder and side, so a big project reads as a few boxes.
 * Groups sit left to right by the longest chain of group links (sources, staging, intermediate, marts);
 * a project whose folders feed each other in a loop falls back to each group's nearest distance.
 */
export function foldersView(graph: LineageGraph, id: string): Layered {
  type Group = { key: string; folder: string; count: number; dist: number; far: number; side: 'up' | 'down' }
  const groups = new Map<string, Group>()
  const groupOf = new Map<string, string>()
  for (const side of ['up', 'down'] as const) {
    for (const [one, d] of walk(graph, id, side === 'up' ? 'parents' : 'children', Infinity)) {
      const folder = folderOf(nodeOf(graph, one))
      const key = `group:${side}:${folder}`
      const group = groups.get(key) ?? { key, folder, count: 0, dist: d, far: d, side }
      group.count++
      group.dist = Math.min(group.dist, d)
      group.far = Math.max(group.far, d)
      groups.set(key, group)
      groupOf.set(one, key)
    }
  }
  const keyOf = (one: string) => (one === id ? id : groupOf.get(one))
  const links: [string, string][] = []
  for (const [child, parents] of Object.entries(graph.parents)) {
    for (const parent of parents) {
      const from = keyOf(parent)
      const to = keyOf(child)
      if (from && to) links.push([from, to])
    }
  }
  const edgesAll = dedupe(links)

  // Kahn's algorithm: a group's layer is the longest path to it from a group nothing feeds.
  const level = new Map<string, number>([...groups.keys(), id].map(key => [key, 0]))
  const waiting = new Map([...level.keys()].map(key => [key, edgesAll.filter(([, to]) => to === key).length]))
  const queue = [...level.keys()].filter(key => waiting.get(key) === 0)
  let done = 0
  while (queue.length > 0) {
    const key = queue.shift()!
    done++
    for (const [from, to] of edgesAll) {
      if (from !== key) continue
      level.set(to, Math.max(level.get(to)!, level.get(key)! + 1))
      waiting.set(to, waiting.get(to)! - 1)
      if (waiting.get(to) === 0) queue.push(to)
    }
  }

  const label = (group: Group) => {
    const more = group.side === 'down' ? graph.truncated : graph.upTruncated
    // How many levels of the chain the folder spans: a 12-hop project reads as where its depth sits.
    const levels = group.far - group.dist + 1
    return `${group.folder} (${group.count}${more ? '+' : ''})${levels > 1 ? ` · ${levels} levels` : ''}`
  }
  const box = (group: Group): LayoutBox => ({ key: group.key, label: label(group), kind: 'group' })
  const order = (a: Group, b: Group) => b.count - a.count || a.folder.localeCompare(b.folder)
  let layers: LayoutBox[][]
  if (done === level.size) {
    const rank = [...new Set(level.values())].sort((a, b) => a - b)
    layers = rank.map(value => {
      const here = [...groups.values()].filter(group => level.get(group.key) === value).sort(order)
      return level.get(id) === value ? [boxOf(graph, id, id), ...here.map(box)] : here.map(box)
    })
  } else {
    // Folders that feed each other both ways (marts reading intermediate models and back) have no
    // flow order of their own: dbt's usual layering stands in, other folder names in the middle.
    const RANK: Record<string, number> = { sources: 0, seeds: 0, snapshots: 0, staging: 1, intermediate: 2, marts: 3, dashboards: 4 }
    const column = (side: 'up' | 'down') => {
      const mine = [...groups.values()].filter(group => group.side === side)
      const rankOf = (group: Group) => RANK[group.folder] ?? 2.5
      const ranks = [...new Set(mine.map(rankOf))].sort((a, b) => a - b)
      return ranks.map(r => mine.filter(group => rankOf(group) === r).sort(order).map(box))
    }
    layers = [...column('up'), [boxOf(graph, id, id)], ...column('down')]
  }
  const layerOf = new Map<string, number>()
  layers.forEach((boxes, index) => boxes.forEach(one => layerOf.set(one.key, index)))
  return { layers, edges: edgesAll.filter(([from, to]) => layerOf.get(from)! < layerOf.get(to)!) }
}

const GAP = 7
const MAX_BOX = 28
// Boxes narrow to this before a layer is dropped: dbt names past it read poorly.
const DROP_BOX = 16
const MIN_BOX = 12
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

type Gap = { byFrom: Map<string, string[]>; oneTarget: boolean; width: number }

/**
 * The lines in each gap between adjacent layers. A gap has a column for every source, plus the column
 * the lines leave by and the one the arrows sit in, so no two sources share a channel; sources that all
 * end on one box share a single line, which cannot be misread, and keep the standard width.
 */
function gapsOf(layers: LayoutBox[][], edges: [string, string][]): Gap[] {
  const layerOf = new Map<string, number>()
  layers.forEach((boxes, index) => boxes.forEach(box => layerOf.set(box.key, index)))
  const gaps: Gap[] = layers.slice(1).map(() => ({ byFrom: new Map<string, string[]>(), oneTarget: false, width: GAP }))
  for (const [from, to] of edges) {
    const a = layerOf.get(from)
    if (a === undefined || layerOf.get(to) !== a + 1) continue
    const gap = gaps[a]!
    gap.byFrom.set(from, [...(gap.byFrom.get(from) ?? []), to])
  }
  for (const gap of gaps) {
    gap.oneTarget = new Set([...gap.byFrom.values()].flat()).size === 1
    gap.width = gap.oneTarget ? GAP : Math.max(GAP, gap.byFrom.size + 2)
  }
  return gaps
}

/** Cuts a label to `room` columns in the middle, keeping a short head and the longer tail; a `◆ `/`⋯ ` prefix and a ` · via N` suffix stay whole. */
function fit(label: string, room: number): string {
  if (label.length <= room) return label
  const prefix = /^(◆ |⋯ |\+\d+ more)/.exec(label)?.[0] ?? ''
  const suffix = / · via \d+$/.exec(label)?.[0] ?? ''
  const name = label.slice(prefix.length, label.length - suffix.length)
  const left = room - prefix.length - suffix.length
  if (left < 5) return `${label.slice(0, Math.max(0, room - 1))}…`
  const head = Math.max(2, Math.floor((left - 1) / 3))
  return `${prefix}${name.slice(0, head)}…${name.slice(name.length - (left - 1 - head))}${suffix}`
}

/**
 * A label as the lines of a box `room` columns wide: one when it fits, else two split after `_` or a space
 * (greedy; a first part longer than the line is split hard). A `◆ ` prefix stays on the first line and a
 * ` · via N` suffix on the last. Only when two lines cannot hold it is the second cut in the middle.
 */
function wrap(label: string, room: number): string[] {
  if (label.length <= room) return [label]
  const suffix = / · via \d+$/.exec(label)?.[0] ?? ''
  const name = label.slice(0, label.length - suffix.length)
  const parts = name.split(/(?<=[_ ])/)
  const split = (at: number) => [parts.slice(0, at).join('').trimEnd(), `${parts.slice(at).join('').trimStart()}${suffix}`] as const
  // The split after `_` that leaves the two lines closest in length; none that fits both: fill the first.
  let best: readonly [string, string] | null = null
  for (let at = 1; at < parts.length; at++) {
    const [one, two] = split(at)
    if (one.length > room || two.length > room) continue
    if (!best || Math.max(one.length, two.length) < Math.max(best[0].length, best[1].length)) best = [one, two]
  }
  if (best) return [...best]
  let first = ''
  for (const part of parts) {
    if (first.length + part.length > room && first.length > 0) break
    first += part
  }
  if (first.length > room) first = first.slice(0, room)
  const rest = name.slice(first.length).trimStart()
  // No break fits both lines: a name that two lines can hold is split hard across them before any middle cut.
  if (rest.length + suffix.length > room && name.length > room && name.length - room + suffix.length <= room) return [name.slice(0, room), `${name.slice(room)}${suffix}`]
  return [first.trimEnd(), rest ? fit(`${rest}${suffix}`, room) : suffix.trimStart()]
}

function place(layers: LayoutBox[][], cap: number, gaps: Gap[]) {
  const widths = layers.map(boxes => Math.min(cap, Math.max(0, ...boxes.map(box => box.label.length)) + 4))
  // Boxes share one height: three rows, or four when any label needs a second line.
  const tall = layers.some((boxes, layer) => boxes.some(box => box.label.length > widths[layer]! - 4))
  const boxHeight = tall ? 4 : 3
  const pitch = boxHeight + 1
  const heights = layers.map(boxes => boxes.length * pitch - 1)
  const total = Math.max(0, ...heights)
  const width = widths.reduce((sum, w) => sum + w, 0) + gaps.reduce((sum, gap) => sum + gap.width, 0)
  const spots = new Map<string, Placed>()
  let x = 0
  layers.forEach((boxes, layer) => {
    const top = Math.floor((total - heights[layer]!) / 2)
    boxes.forEach((box, i) => spots.set(box.key, { x, y: top + i * pitch, w: widths[layer]!, layer }))
    x += widths[layer]! + (gaps[layer]?.width ?? 0)
  })
  return { spots, width, height: total, boxHeight }
}

/** Paints a box at (x, y); `exit` puts a junction on the right border of the first label row where a line leaves. */
function paintBox(cells: Map<number, Cell>[], box: LayoutBox, x: number, y: number, w: number, boxHeight: number, exit: boolean) {
  const style = styleOf(box)
  const [tl, tr, bl, br, hz, vt] = box.kind === 'focus' ? ['┏', '┓', '┗', '┛', '━', '┃'] : ['┌', '┐', '└', '┘', '─', '│']
  const lines = wrap(box.label, w - 4)
  const put = (cx: number, cy: number, ch: string, node?: string) => {
    cells[cy]!.set(cx, node ? { ch, node, style } : { ch, style })
  }
  const bottom = y + boxHeight - 1
  put(x, y, tl)
  put(x + w - 1, y, tr)
  put(x, bottom, bl)
  put(x + w - 1, bottom, br)
  for (let i = 1; i < w - 1; i++) {
    put(x + i, y, hz)
    put(x + i, bottom, hz)
  }
  for (let row = 1; row < boxHeight - 1; row++) {
    const text = lines[row - 1] ?? ''
    put(x, y + row, vt)
    put(x + w - 1, y + row, row === 1 && exit ? (vt === '┃' ? '┠' : '├') : vt)
    for (let i = 1; i < w - 1; i++) put(x + i, y + row, i >= 2 && i - 2 < text.length ? text[i - 2]! : ' ', box.node)
  }
}

/**
 * The grid as rows of styled runs. Only drawn cells are stored (`cells`, a map per row) and line cells come
 * from the direction masks (a byte per column); a row is walked over the columns that hold something, the
 * blanks between them are runs of spaces, and trailing blanks are dropped.
 */
function toSegments(cells: Map<number, Cell>[], mask: Uint8Array[]): Segment[][] {
  const dim: Style = { dim: true }
  const blank: Cell = { ch: ' ' }
  return cells.map((line, y) => {
    const marks = mask[y]!
    const columns: number[] = [...line.keys()]
    for (let x = 0; x < marks.length; x++) if (marks[x]! !== 0 && !line.has(x)) columns.push(x)
    columns.sort((p, q) => p - q)
    const runs: { cell: Cell; count: number }[] = []
    let at = 0
    for (const x of columns) {
      if (x > at) runs.push({ cell: blank, count: x - at })
      runs.push({ cell: line.get(x) ?? { ch: JOINT[marks[x]!]!, style: dim }, count: 1 })
      at = x + 1
    }
    while (runs.length > 0 && runs[runs.length - 1]!.cell.ch === ' ' && !runs[runs.length - 1]!.cell.node) runs.pop()
    if (runs.length === 0) return [{ text: '' }]
    const out: Segment[] = []
    let last: Cell | null = null
    for (const { cell, count } of runs) {
      if (last && sameStyle(last, cell)) out[out.length - 1]!.text += cell.ch.repeat(count)
      else {
        const seg: Segment = { text: cell.ch.repeat(count) }
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
}

/**
 * Draws the layers as boxes joined by right-angled lines. Boxes narrow first; layers that still do
 * not fit `maxWidth` are dropped, counted in `hidden`: upstream past the first level, then the farthest
 * downstream and upstream in turn. One layer that is still too wide has its boxes narrowed further.
 * With `maxWidth` Infinity nothing is dropped, narrowed, wrapped or cut: the drawing is as wide as it needs.
 */
export function drawLayered(view: Layered, maxWidth: number): { rows: Segment[][]; hidden: number } {
  let layers = view.layers
  let hidden = 0
  const focusAt = Math.max(0, layers.findIndex(boxes => boxes.some(box => box.kind === 'focus')))
  let before = focusAt
  let dropDown = true
  // The narrowest box that still shows every name whole on its two lines: a level drops before a name is cut.
  const readable = (list: LayoutBox[][]) => {
    const labels = list.flat().map(box => box.label)
    let w = Math.min(DROP_BOX, MAX_BOX)
    while (w < MAX_BOX && labels.some(label => wrap(label, w - 4).some(line => line.includes('…')))) w++
    return w
  }
  // Levels past the model's own parents and children drop before a name is cut; those two levels drop
  // only when even narrowed boxes do not fit.
  const readableWidth = (list: LayoutBox[][]) => place(list, readable(list), gapsOf(list, view.edges)).width
  const narrowWidth = (list: LayoutBox[][]) => place(list, DROP_BOX, gapsOf(list, view.edges)).width
  const tooWide = () =>
    layers.length > 1 && (((before > 1 || layers.length - before - 1 > 1) && readableWidth(layers) > maxWidth) || narrowWidth(layers) > maxWidth)
  while (Number.isFinite(maxWidth) && tooWide()) {
    const after = layers.length - before - 1
    // Only the names do not fit: drop a level past the model's own parents and children, never those.
    const forNames = narrowWidth(layers) <= maxWidth
    const alternate = before <= 1 && !forNames
    const upstream = forNames ? before > 1 && (after <= 1 || !dropDown) : before > 1 || after === 0 || (!dropDown && before > 0)
    if (upstream) {
      layers = layers.slice(1)
      before--
    } else layers = layers.slice(0, -1)
    if (alternate) dropDown = !dropDown
    hidden++
  }
  // An unbounded width keeps every level and every name whole: boxes are as wide as their longest label.
  let cap = Number.isFinite(maxWidth) ? MAX_BOX : Infinity
  while (cap > MIN_BOX && place(layers, cap, gapsOf(layers, view.edges)).width > maxWidth) cap--

  const gapList = gapsOf(layers, view.edges)
  const { spots, width, boxHeight } = place(layers, cap, gapList)
  if (layers.length === 0) return { rows: [], hidden }

  // Channel order per gap. Sources whose lines run down go top first and the rest bottom first, and
  // the first get the rightmost channels, so one source's line does not cut the next one's run. A line
  // that arrives on another source's row must also turn in right of that source's own turn, or the two
  // runs read as one line between models that are not linked. When two sources each need the other's
  // right, the target layer moves down two rows: its rows then never meet a source's row.
  const orders = gapList.map((gap, index) => {
    const rowOf = (from: string) => spots.get(from)!.y + 1
    const plan = () => {
      const { byFrom, oneTarget } = gap
      const goesDown = (from: string) => byFrom.get(from)!.reduce((sum, to) => sum + spots.get(to)!.y + 1 - rowOf(from), 0) >= 0
      const sources = [...byFrom.keys()]
      const downs = sources.filter(goesDown).sort((p, q) => rowOf(p) - rowOf(q))
      const ups = sources.filter(from => !goesDown(from)).sort((p, q) => rowOf(q) - rowOf(p))
      const preferred = [...downs, ...ups]
      if (oneTarget) return preferred
      const onRow = new Map(sources.map(from => [rowOf(from), from]))
      const after = new Map(sources.map(from => [from, new Set<string>()]))
      for (const from of sources) {
        for (const to of byFrom.get(from)!) {
          const other = onRow.get(spots.get(to)!.y + 1)
          if (other && other !== from && !byFrom.get(other)!.includes(to)) after.get(from)!.add(other)
        }
      }
      // Kahn's order over "comes before", ties in the preferred order.
      const waiting = new Map(sources.map(from => [from, 0]))
      for (const later of after.values()) for (const one of later) waiting.set(one, waiting.get(one)! + 1)
      const order: string[] = []
      while (order.length < sources.length) {
        const next = preferred.find(from => waiting.get(from) === 0 && !order.includes(from))
        if (!next) return null
        order.push(next)
        for (const one of after.get(next)!) waiting.set(one, waiting.get(one)! - 1)
      }
      return order
    }
    const order = plan()
    if (order) return order
    for (const box of layers[index + 1] ?? []) spots.get(box.key)!.y += 2
    return plan()!
  })
  const height = Math.max(0, ...[...spots.values()].map(spot => spot.y + boxHeight))
  const cells: Map<number, Cell>[] = Array.from({ length: height }, () => new Map<number, Cell>())
  const mask: Uint8Array[] = Array.from({ length: height }, () => new Uint8Array(width))

  const linked = new Set<string>()
  const dim: Style = { dim: true }
  const h = (x1: number, x2: number, y: number) => {
    for (let x = x1; x < x2; x++) {
      mask[y]![x]! |= E
      mask[y]![x + 1]! |= W
    }
  }
  gapList.forEach(({ byFrom, oneTarget, width: gapWidth }, index) => {
    const channels = gapWidth - 2
    const order = orders[index]!
    const first = Math.min(channels, order.length + 2)
    // Lines that all end on one box merge into one channel: a shared line cannot be misread there.
    order.forEach((from, at) => {
      const a = spots.get(from)!
      const channel = oneTarget ? Math.ceil(channels / 2) : first - (at % first)
      const ys = a.y + 1
      const targets = byFrom.get(from)!
      linked.add(from)
      const rows = targets.map(to => spots.get(to)!.y + 1)
      const x0 = a.x + a.w
      const column = x0 + channel
      for (const [i, to] of targets.entries()) {
        const yt = rows[i]!
        if (yt === ys) {
          h(x0, x0 + channels, ys)
        } else {
          h(x0, column, ys)
          h(column, x0 + channels, yt)
        }
        mask[yt]![x0 + channels]! |= E
        const b = spots.get(to)!
        cells[yt]!.set(b.x - 1, { ch: '▶', style: dim })
      }
      const lo = Math.min(ys, ...rows)
      const hi = Math.max(ys, ...rows)
      for (let y = lo; y < hi; y++) {
        mask[y]![column]! |= S
        mask[y + 1]![column]! |= N
      }
    })
  })

  for (const boxes of layers) {
    for (const box of boxes) {
      const { x, y, w } = spots.get(box.key)!
      paintBox(cells, box, x, y, w, boxHeight, linked.has(box.key))
    }
  }

  const rows = toSegments(cells, mask)
  return { rows, hidden }
}

/**
 * Draws the layers top to bottom, each layer's boxes side by side (wrapping at `maxWidth`), with one
 * arrow down between layers: the folders view, a handful of boxes that read as one chain from the
 * sources to the marts in any pane width. Links between single boxes are not drawn here.
 */
export function drawStack(view: Layered, maxWidth: number): Segment[][] {
  const rows: Segment[][] = []
  const widthOf = (box: LayoutBox) => Math.max(MIN_BOX, Math.min(maxWidth, MAX_BOX, box.label.length + 4))
  const segment = (text: string, style: Style, node?: string): Segment => ({ text, ...style, ...(node && { node }) })
  view.layers.forEach((layer, index) => {
    if (index > 0) rows.push([{ text: '   │', dim: true }], [{ text: '   ▼', dim: true }])
    const lines: LayoutBox[][] = [[]]
    let used = 0
    for (const box of layer) {
      const w = widthOf(box) + (lines.at(-1)!.length > 0 ? 2 : 0)
      if (lines.at(-1)!.length > 0 && used + w > maxWidth) {
        lines.push([])
        used = 0
      }
      used += widthOf(box) + (lines.at(-1)!.length > 0 ? 2 : 0)
      lines.at(-1)!.push(box)
    }
    for (const boxes of lines) {
      // The boxes of one line share a height: a second label row when any name needs it.
      const wrapped = boxes.map(box => wrap(box.label, widthOf(box) - 4))
      const labelRows = Math.max(...wrapped.map(one => one.length))
      const top: Segment[] = []
      const bottom: Segment[] = []
      const mids: Segment[][] = Array.from({ length: labelRows }, () => [])
      boxes.forEach((box, i) => {
        const w = widthOf(box)
        const style = styleOf(box)
        const border = box.kind === 'group' ? { dim: true } : style
        const [tl, tr, bl, br, hz, vt] = box.kind === 'focus' ? ['┏', '┓', '┗', '┛', '━', '┃'] : ['┌', '┐', '└', '┘', '─', '│']
        const gap = i > 0 ? '  ' : ''
        top.push(segment(`${gap}${tl}${hz.repeat(w - 2)}${tr}`, border))
        mids.forEach((mid, row) => {
          mid.push(segment(`${gap}${vt} `, border), segment((wrapped[i]![row] ?? '').padEnd(w - 4), box.kind === 'group' ? {} : style, box.node), segment(` ${vt}`, border))
        })
        bottom.push(segment(`${gap}${bl}${hz.repeat(w - 2)}${br}`, border))
      })
      rows.push(top, ...mids, bottom)
    }
  })
  return rows
}

/** The columns [from, from + width) of each row, segments split at the edges with their style and `node` kept. */
export function sliceRows(rows: Segment[][], from: number, width: number): Segment[][] {
  const to = from + width
  return rows.map(row => {
    const out: Segment[] = []
    let at = 0
    for (const seg of row) {
      const chars = [...seg.text]
      const start = Math.max(from, at)
      const end = Math.min(to, at + chars.length)
      if (end > start) out.push({ ...seg, text: chars.slice(start - at, end - at).join('') })
      at += chars.length
    }
    return out.length > 0 ? out : [{ text: '' }]
  })
}

/** The first column where a segment of `node` starts, or -1: centres a window on the focus. */
export function columnOf(rows: Segment[][], node: string): number {
  let first = -1
  for (const row of rows) {
    let at = 0
    for (const seg of row) {
      if (seg.node === node && (first < 0 || at < first)) first = at
      at += [...seg.text].length
    }
  }
  return first
}

/**
 * What drawing these rows costs Claude Code: its elements (a row's box and each piece of it, a press
 * target counted twice for its label) and its characters. Claude Code refuses a pane over 20,000
 * elements and draws only the first 100,000 characters of its text.
 */
export function drawingSize(rows: Segment[][]): { elements: number; chars: number } {
  let elements = 0
  let chars = 0
  for (const row of rows) {
    elements += 1
    for (const one of row) {
      elements += one.node ? 2 : 1
      chars += one.text.length
    }
  }
  return { elements, chars }
}
