// The lineage pane's data, with no engine calls: the model graph read from a dbt manifest, the
// column lineage dbt_lineage returns (as structured metadata, or parsed from its text for older
// altimate-code builds), impact_analysis' severity thresholds, and the desktop SVG.

import type {
  ColumnEdge,
  ColumnLineage,
  ColumnReachView,
  GraphNode,
  LineageGraph,
  WarehouseEdge,
} from '../types'

/** A dbt manifest, as far as the pane reads it. */
type Manifest = {
  nodes?: Record<string, any>
  sources?: Record<string, any>
  exposures?: Record<string, any>
  metrics?: Record<string, any>
  semantic_models?: Record<string, any>
  saved_queries?: Record<string, any>
  unit_tests?: Record<string, any>
  parent_map?: Record<string, string[]>
  child_map?: Record<string, string[]>
}

function nodeOf(id: string, node: any): GraphNode {
  const type: string = node?.resource_type ?? id.split('.')[0] ?? 'unknown'
  const columns = Object.entries<any>(node?.columns ?? {}).map(([key, col]) => String(col?.name ?? key))
  return {
    id,
    name: node?.name ?? id.split('.').pop() ?? id,
    label: type === 'exposure' ? node?.label || node?.name || id : null,
    type,
    path: node?.original_file_path ?? null,
    materialized: node?.config?.materialized ?? null,
    relation: relationOf(node),
    columns,
  }
}

/** `"db"."schema"."orders"` → `db.schema.orders`, lower-cased: how the warehouse names the relation. */
function relationOf(node: any): string | null {
  // dbt writes relation_name: null for a node with no table (an ephemeral model): there is none.
  if (node && 'relation_name' in node && node.relation_name === null) return null
  if (typeof node?.relation_name === 'string' && node.relation_name) {
    return node.relation_name.replace(/[`"\[\]]/g, '').toLowerCase()
  }
  const parts = [node?.database, node?.schema, node?.alias ?? node?.identifier ?? node?.name].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  )
  return parts.length === 3 ? parts.join('.').toLowerCase() : null
}

/** The manifest's graph: dbt's own parent_map / child_map, rebuilt from depends_on when absent. */
export function buildGraph(manifest: Manifest): LineageGraph {
  const nodes: Record<string, GraphNode> = {}
  const groups = [manifest.nodes, manifest.sources, manifest.exposures, manifest.metrics, manifest.semantic_models, manifest.saved_queries, manifest.unit_tests]
  for (const group of groups) for (const [id, node] of Object.entries<any>(group ?? {})) nodes[id] = nodeOf(id, node)

  let parents: Record<string, string[]>
  let children: Record<string, string[]>
  if (manifest.parent_map && manifest.child_map) {
    parents = manifest.parent_map
    children = manifest.child_map
  } else {
    parents = {}
    children = {}
    for (const group of groups) {
      for (const [id, node] of Object.entries<any>(group ?? {})) {
        parents[id] = node?.depends_on?.nodes ?? []
        for (const parent of parents[id]!) (children[parent] ??= []).push(id)
      }
    }
  }
  return { nodes, parents, children }
}

/** Nodes the pane can follow: they have SQL that dbt_lineage traces. */
export const FOLLOWABLE = new Set(['model', 'snapshot'])

/** The model or snapshot a file path (project-relative, forward slashes), a name or a unique_id names. */
export function findModel(graph: LineageGraph, wanted: string): string | null {
  if (FOLLOWABLE.has(graph.nodes[wanted]?.type ?? '')) return wanted
  const lowered = wanted.toLowerCase()
  for (const node of Object.values(graph.nodes)) {
    if (!FOLLOWABLE.has(node.type)) continue
    if (node.path === wanted || node.name.toLowerCase() === lowered) return node.id
  }
  return null
}

const isTest = (node: GraphNode | undefined, id: string) => ['test', 'unit_test'].includes(node?.type ?? id.split('.')[0] ?? '')

/** Direct parents, each with its own parents: the two levels the pane draws upstream. */
export function upstreamOf(graph: LineageGraph, id: string): { node: GraphNode; parents: GraphNode[] }[] {
  const named = (ids: string[] | undefined) =>
    (ids ?? []).filter(one => !isTest(graph.nodes[one], one)).map(one => graph.nodes[one] ?? nodeOf(one, null))
  return named(graph.parents[id]).map(node => ({ node, parents: named(graph.parents[node.id]) }))
}

export type DownstreamRow = { node: GraphNode; depth: number; via: string }

/**
 * Everything downstream, breadth-first, so each node carries its shortest distance (impact_analysis
 * walks depth-first, so in a diamond it may report a longer path); tests are counted, not listed.
 */
export function downstreamOf(graph: LineageGraph, id: string): { rows: DownstreamRow[]; tests: number } {
  const rows: DownstreamRow[] = []
  const seen = new Set([id])
  let tests = 0
  let frontier = [id]
  for (let depth = 1; frontier.length > 0; depth++) {
    const next: string[] = []
    for (const parent of frontier) {
      for (const child of graph.children[parent] ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        const node = graph.nodes[child] ?? nodeOf(child, null)
        if (isTest(graph.nodes[child], child)) {
          tests++
          continue
        }
        rows.push({ node, depth, via: parent })
        next.push(child)
      }
    }
    frontier = next
  }
  return { rows, tests }
}

export type Severity = 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH'

/** impact_analysis' thresholds, over downstream models. */
export function severityOf(downstreamModels: number): Severity {
  return downstreamModels === 0 ? 'SAFE' : downstreamModels <= 3 ? 'LOW' : downstreamModels <= 10 ? 'MEDIUM' : 'HIGH'
}

export type ImpactCounts = { direct: number; transitive: number; tests: number; exposures: string[]; severity: Severity }

export function impactOf(graph: LineageGraph, id: string): ImpactCounts {
  const { rows, tests } = downstreamOf(graph, id)
  const models = rows.filter(row => FOLLOWABLE.has(row.node.type))
  return {
    direct: models.filter(row => row.depth === 1).length,
    transitive: models.filter(row => row.depth > 1).length,
    tests,
    exposures: rows.filter(row => row.node.type === 'exposure').map(row => row.node.label ?? row.node.name),
    severity: severityOf(models.length),
  }
}

// altimate-core quotes identifiers: '"int_orders"."revenue"' → int_orders.revenue
export function sourceName(source: unknown): string {
  const text = typeof source === 'string' ? source : String((source as any)?.source ?? '')
  return text.replace(/[`"\[\]]/g, '')
}

/**
 * The dbt integration's model lineage (dbt_lineage when altimate-code runs it through the project's
 * dbt adapter): the focus model's column edges become the pane's columns, its parents the upstream.
 */
export function columnsFromModelLineage(lineage: any): ColumnLineage | null {
  const focus = lineage?.focus
  if (!focus || typeof focus.uniqueId !== 'string' || !Array.isArray(lineage.columnLineage) || !Array.isArray(lineage.nodes)) return null
  const names = new Map<string, string>(lineage.nodes.map((node: any) => [String(node?.uniqueId), String(node?.name ?? node?.uniqueId)]))
  const ref = (pair: unknown) => (Array.isArray(pair) && pair.length === 2 ? { node: String(pair[0]), column: String(pair[1]) } : null)
  const edges: ColumnEdge[] = []
  const columns = new Map<string, string[]>()
  for (const edge of lineage.columnLineage) {
    const source = ref(edge?.source)
    const target = ref(edge?.target)
    if (!source || !target || target.node !== focus.uniqueId) continue
    const from = `${names.get(source.node) ?? source.node}.${source.column}`
    const code = Array.isArray(edge?.viewsCode) ? edge.viewsCode : []
    edges.push({
      source: from,
      target: target.column,
      lineageType: edge?.type === 'indirect' ? 'indirect' : 'direct',
      lens: String(edge?.viewsType ?? 'Not sure'),
      // The last step is the expression that produces the column, as altimate-code's text shows it.
      expression: code.length > 0 ? String(code[code.length - 1]) : null,
    })
    if (edge?.type !== 'indirect') columns.set(target.column, [...(columns.get(target.column) ?? []), from])
  }
  const focusNode = lineage.nodes.find((node: any) => node?.uniqueId === focus.uniqueId)
  // Columns the integration knows but no edge reaches still belong in the list.
  for (const column of Array.isArray(focusNode?.columns) ? focusNode.columns : []) {
    if (typeof column?.name === 'string' && !columns.has(column.name)) columns.set(column.name, [])
  }
  return {
    model: String(focus.name ?? focus.uniqueId),
    id: focus.uniqueId,
    confidence: lineage.confidence === 'high' ? 'high' : 'low',
    note: Array.isArray(lineage.errors) && lineage.errors[0] ? String(lineage.errors[0]) : null,
    upstream: Array.isArray(focusNode?.parents) ? focusNode.parents.map(String) : [],
    columns: [...columns].map(([name, sources]) => ({ name, sources })),
    edges,
  }
}

/** dbt_lineage's structured metadata (altimate-code builds that send it) → the pane's columns. */
export function columnsFromMetadata(metadata: any): ColumnLineage | null {
  // The dbt integration's model lineage, sent as the result itself or inside the tool's metadata.
  const modelLineage = columnsFromModelLineage(metadata) ?? columnsFromModelLineage(metadata?.structuredContent)
  if (modelLineage) return modelLineage
  if (!metadata || typeof metadata !== 'object' || !metadata.columns || typeof metadata.columns !== 'object') return null
  const edges: ColumnEdge[] = (Array.isArray(metadata.edges) ? metadata.edges : []).map((edge: any) => ({
    source: sourceName(edge?.source),
    target: String(edge?.target ?? ''),
    lineageType: edge?.lineage_type === 'indirect' ? 'indirect' : 'direct',
    lens: String(edge?.lens_type ?? 'Not sure'),
    expression: firstTransform(edge?.lens_code),
  }))
  return {
    model: String(metadata.model_name ?? ''),
    ...(typeof metadata.model_unique_id === 'string' && { id: metadata.model_unique_id }),
    confidence: metadata.confidence === 'high' ? 'high' : 'low',
    note: Array.isArray(metadata.confidence_factors) && metadata.confidence_factors[0] ? String(metadata.confidence_factors[0]) : null,
    upstream: Array.isArray(metadata.upstream) ? metadata.upstream.map(String) : [],
    columns: Object.entries<any>(metadata.columns).map(([name, sources]) => ({
      name,
      sources: (Array.isArray(sources) ? sources : [sources]).map(sourceName),
    })),
    edges,
  }
}

function firstTransform(code: unknown): string | null {
  if (!Array.isArray(code)) return null
  const step = code.find((one: any) => one?.step_type === 'transform' && typeof one?.expression === 'string')
  return step ? String(step.expression) : null
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * dbt_lineage's text (formatDbtLineage): the "Column Mappings" and "Lineage Edges" sections, one
 * JSON value per line. For altimate-code builds whose dbt_lineage sends no structured metadata.
 */
export function parseDbtLineage(text: string): ColumnLineage {
  const mappings: Record<string, unknown> = {}
  const edges: any[] = []
  let section: 'map' | 'edges' | null = null
  for (const line of text.split('\n')) {
    if (line === 'Column Mappings:') {
      section = 'map'
      continue
    }
    if (line === 'Lineage Edges:') {
      section = 'edges'
      continue
    }
    if (!line.startsWith('  ')) {
      section = null
      continue
    }
    if (section === 'map') {
      const at = line.indexOf(' ← ')
      if (at > 0) mappings[line.slice(2, at)] = safeJson(line.slice(at + 3))
    } else if (section === 'edges') {
      const edge = safeJson(line.trim())
      if (edge) edges.push(edge)
    }
  }
  const model = /^Model: (.+)$/m.exec(text)?.[1] ?? ''
  const note = /^\s+Note: (.+)$/m.exec(text)?.[1] ?? null
  return columnsFromMetadata({
    model_name: model,
    confidence: /^Confidence: low/m.test(text) || note ? 'low' : 'high',
    confidence_factors: note ? [note] : [],
    columns: mappings,
    edges,
  })!
}

/** impact_analysis' column_reach metadata → the pane's column box; null for builds without it. */
export function reachFromMetadata(metadata: any, model: string, column: string): ColumnReachView | null {
  const reach = metadata?.column_reach
  if (!reach || !Array.isArray(reach.models)) return null
  return {
    model,
    column,
    models: reach.models.map((one: any) => ({
      name: String(one?.name ?? ''),
      ...(typeof one?.unique_id === 'string' && { id: one.unique_id }),
      columns: Array.isArray(one?.columns) ? one.columns.map(String) : [],
    })),
    exposures: labels(reach.exposures),
    uncertainExposures: labels(reach.uncertain_exposures),
    uncertain: unsure(reach.uncertain),
    untraced: unsure(reach.untraced),
    truncated: reach.truncated === true,
  }
}

const labels = (list: unknown) => (Array.isArray(list) ? list : []).map((one: any) => String(one?.label ?? one?.name ?? ''))
const unsure = (list: unknown) =>
  (Array.isArray(list) ? list : []).map((one: any) => ({
    name: String(one?.name ?? ''),
    ...(typeof one?.unique_id === 'string' && { id: one.unique_id }),
    reason: String(one?.reason ?? ''),
  }))

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g

function counts(texts: string[]): Map<string, number> {
  const found = new Map<string, number>()
  for (const text of texts) for (const word of text.match(IDENT) ?? []) found.set(word.toLowerCase(), (found.get(word.toLowerCase()) ?? 0) + 1)
  return found
}

/**
 * The model's columns an edit changes: those named on a line the edit adds or removes (lines only
 * in unchanged context do not count), the ones whose number of mentions changed most first.
 */
export function touchedColumns(before: string[], after: string[], columns: string[]): string[] {
  const lines = (texts: string[]) => texts.flatMap(text => text.split('\n').map(line => line.trim()))
  const was = lines(before)
  const now = lines(after)
  // A line repeated in one text and not in the other counts once per extra copy.
  const surplus = (from: string[], other: string[]) => {
    const left = new Map<string, number>()
    for (const line of other) left.set(line, (left.get(line) ?? 0) + 1)
    return from.filter(line => {
      const n = left.get(line) ?? 0
      if (n > 0) left.set(line, n - 1)
      return n === 0
    })
  }
  const changed = [...surplus(now, was), ...surplus(was, now)]
  const named = counts(changed)
  // The output columns whose select item the edit rewrote, added or removed come first.
  const outBefore = selectItems(before.join('\n'))
  const outAfter = selectItems(after.join('\n'))
  const rewritten = new Set([...new Set([...outBefore.keys(), ...outAfter.keys()])].filter(name => outBefore.get(name) !== outAfter.get(name)))
  const wasCount = counts(before)
  const nowCount = counts(after)
  const shift = (column: string) => Math.abs((nowCount.get(column.toLowerCase()) ?? 0) - (wasCount.get(column.toLowerCase()) ?? 0))
  const rank = (column: string) => (rewritten.has(column.toLowerCase()) ? 1000 : 0) + shift(column)
  return columns.filter(column => named.has(column.toLowerCase()) || rewritten.has(column.toLowerCase())).sort((a, b) => rank(b) - rank(a))
}

/**
 * Output name → expressions for every select item in a piece of SQL, across every SELECT scope
 * (CTEs and subqueries included). The scan keeps string literals and Jinja blocks whole (their
 * commas, parentheses and keywords do not count) and drops comments. A scope's list runs from its
 * SELECT to the FROM at the same depth, or to the closing parenthesis or the end. A fragment with no
 * SELECT (an Edit's old/new strings) is read as one list. Names come from `AS name`, a trailing
 * implicit alias, or the column itself (`t.col`); casts and table aliases are not outputs.
 */
export function selectItems(sql: string): Map<string, string> {
  type Token = { text: string; depth: number; word: string | null }
  const tokens: Token[] = []
  let depth = 0
  for (let i = 0; i < sql.length; ) {
    const rest = sql.slice(i)
    const skip = /^(--[^\n]*|\/\*[\s\S]*?\*\/|\{#[\s\S]*?#\})/.exec(rest)
    if (skip) {
      tokens.push({ text: ' ', depth, word: null })
      i += skip[0].length
      continue
    }
    const whole = /^('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/.exec(rest)
    if (whole) {
      tokens.push({ text: whole[0], depth, word: null })
      i += whole[0].length
      continue
    }
    const word = /^[A-Za-z_]\w*/.exec(rest)
    if (word) {
      tokens.push({ text: word[0], depth, word: word[0].toLowerCase() })
      i += word[0].length
      continue
    }
    const ch = sql[i]!
    // A parenthesis belongs to the group it opens or closes.
    if (ch === '(') depth++
    tokens.push({ text: ch, depth, word: null })
    if (ch === ')') depth = Math.max(0, depth - 1)
    i++
  }

  const lists: Token[][][] = []
  const collect = (from: number, d: number) => {
    const items: Token[][] = [[]]
    for (let k = from; k < tokens.length; k++) {
      const t = tokens[k]!
      if (t.depth < d || (t.depth === d && t.text === ')')) break
      if (t.depth === d && t.word === 'from') break
      if (t.depth === d && t.text === ',') items.push([])
      else items[items.length - 1]!.push(t)
    }
    lists.push(items)
  }
  const selects = tokens.map((t, k) => (t.word === 'select' ? k : -1)).filter(k => k >= 0)
  // A fragment whose SELECTs are all nested (an Edit of one item holding a subquery) is a list itself.
  if (!selects.some(k => tokens[k]!.depth === 0)) collect(0, 0)
  for (const k of selects) collect(k + 1, tokens[k]!.depth)

  const out = new Map<string, string>()
  for (const items of lists) {
    for (const item of items) {
      // Whitespace collapses between tokens only: a literal keeps its own spacing.
      let text = ''
      for (const t of item) text += /^\s$/.test(t.text) ? (text.endsWith(' ') ? '' : ' ') : t.text
      text = text.trim().replace(/^(?:distinct|all)\s+/i, '')
      if (!text) continue
      // Jinja control tags ({% if %} … {% endif %}) wrap an item; the alias is inside them.
      const bare = item
        .filter(t => !/^\{%/.test(t.text))
        .map(t => (/^\s$/.test(t.text) ? ' ' : t.text))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      const name =
        /\bas\s+["`]?([A-Za-z_]\w*)["`]?$/i.exec(bare)?.[1] ??
        /[\s)]["`]?([A-Za-z_]\w*)["`]?$/.exec(bare)?.[1] ??
        /^(?:[A-Za-z_]\w*\.)*["`]?([A-Za-z_]\w*)["`]?$/.exec(bare)?.[1]
      if (!name) continue
      const key = name.toLowerCase()
      // The same name in several scopes (a CTE and the outer select): any of them changing counts.
      out.set(key, out.has(key) ? `${out.get(key)}\u0000${text}` : text)
    }
  }
  return out
}

/** table_lineage records (SaaS MCP) → edges, keeping only well-formed ones. */
export function warehouseEdges(result: any): WarehouseEdge[] {
  const data = result?.data ?? result
  const records = Array.isArray(data?.records) ? data.records : []
  return records
    .filter((one: any) => typeof one?.target_table === 'string' || typeof one?.source_table === 'string')
    .map((one: any) => ({
      source: typeof one.source_table === 'string' ? one.source_table : null,
      target: typeof one.target_table === 'string' ? one.target_table : null,
      hop: Number(one.hop) || 1,
    }))
}

const escape = (text: string) => text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)

/**
 * The desktop drawing: upstream (two levels) on the left, the model in the middle, downstream (two
 * levels) on the right, one column per level.
 */
export function toSvg(graph: LineageGraph, id: string, maxPerColumn = 8): string {
  const focus = graph.nodes[id]
  if (!focus) return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
  const up = upstreamOf(graph, id)
  const { rows } = downstreamOf(graph, id)
  const unique = (nodes: GraphNode[]) => [...new Map(nodes.map(node => [node.id, node])).values()].slice(0, maxPerColumn)
  const columns: GraphNode[][] = [
    unique(up.flatMap(one => one.parents)),
    unique(up.map(one => one.node)),
    [focus],
    unique(rows.filter(row => row.depth === 1).map(row => row.node)),
    unique(rows.filter(row => row.depth === 2).map(row => row.node)),
  ]
  const colWidth = 170
  const rowHeight = 34
  const height = Math.max(...columns.map(col => col.length), 1) * rowHeight + 20
  const width = colWidth * columns.length + 20
  const place = new Map<string, { x: number; y: number }>()
  columns.forEach((col, ci) => {
    const offset = (height - col.length * rowHeight) / 2
    col.forEach((node, ri) => place.set(node.id, { x: 10 + ci * colWidth, y: offset + ri * rowHeight }))
  })
  const links: string[] = []
  for (const [child, at] of place) {
    for (const parent of graph.parents[child] ?? []) {
      const from = place.get(parent)
      if (!from) continue
      links.push(
        `<path d="M${from.x + 140},${from.y + 13} C${from.x + 155},${from.y + 13} ${at.x - 15},${at.y + 13} ${at.x},${at.y + 13}" fill="none" stroke="#8b8d93" stroke-width="1.2"/>`,
      )
    }
  }
  const boxes = [...place].map(([nodeId, at]) => {
    const node = graph.nodes[nodeId]!
    const isFocus = nodeId === id
    const isExposure = node.type === 'exposure'
    const fill = isFocus ? '#f5c86b' : isExposure ? '#e3defa' : '#f1f0ec'
    const text = (isExposure ? '◆ ' : '') + (node.label ?? node.name)
    const short = text.length > 20 ? text.slice(0, 19) + '…' : text
    return (
      `<g><title>${escape(`${text} · ${node.type}${node.materialized ? ` · ${node.materialized}` : ''}`)}</title>` +
      `<rect x="${at.x}" y="${at.y}" width="140" height="26" rx="5" fill="${fill}" stroke="#55585f" stroke-width="${isFocus ? 1.6 : 0.6}"/>` +
      `<text x="${at.x + 8}" y="${at.y + 17}" font-family="ui-monospace,Menlo,monospace" font-size="11" fill="#17181c">${escape(short)}</text></g>`
    )
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${links.join('')}${boxes.join('')}</svg>`
}

/** What the SVG shows, for a reader that cannot see it. */
export function describeGraph(graph: LineageGraph, id: string): string {
  const name = graph.nodes[id]?.name ?? id
  const up = upstreamOf(graph, id).map(one => one.node.name)
  const { rows } = downstreamOf(graph, id)
  const direct = rows.filter(row => row.depth === 1).map(row => row.node.label ?? row.node.name)
  return `${name} is built from ${up.join(', ') || 'nothing upstream'}; ${direct.length} node${direct.length === 1 ? '' : 's'} read it directly${direct.length ? `: ${direct.slice(0, 8).join(', ')}` : ''}.`
}

/**
 * The part of the graph the pane draws for one model: two levels up, everything downstream, and the
 * links between them. Kept in state in place of the whole manifest graph.
 */
export function subgraph(graph: LineageGraph, id: string): LineageGraph {
  const keep = new Set([id])
  for (const parent of graph.parents[id] ?? []) {
    keep.add(parent)
    for (const grand of graph.parents[parent] ?? []) keep.add(grand)
  }
  for (const row of downstreamOf(graph, id).rows) keep.add(row.node.id)
  const nodes: Record<string, GraphNode> = {}
  const parents: Record<string, string[]> = {}
  const children: Record<string, string[]> = {}
  for (const one of keep) {
    nodes[one] = graph.nodes[one] ?? nodeOf(one, null)
    parents[one] = (graph.parents[one] ?? []).filter(other => keep.has(other))
    children[one] = (graph.children[one] ?? []).filter(other => {
      if (keep.has(other)) return true
      // Tests stay as ids so downstream counts them; they are never drawn.
      if (!isTest(graph.nodes[other], other)) return false
      nodes[other] ??= { ...nodeOf(other, null), type: 'test' }
      return true
    })
  }
  return { nodes, parents, children }
}

/** One run of text in a drawn row; `node` makes it a control that follows that node. */
export type Segment = { text: string; node?: string; color?: string; dim?: boolean; bold?: boolean }

const label = (node: GraphNode) => (node.type === 'exposure' ? `◆ ${node.label ?? node.name}` : node.name)
const pad = (text: string, width: number) => ' '.repeat(Math.max(0, width - text.length))

/**
 * Upstream as the pane draws it: each parent's own parents bracket into it, and the parents bracket
 * into the model.
 *
 *   stg_orders   ─┐
 *   stg_payments ─┼─▶ int_orders    ─┐
 *   stg_refunds  ─┘                  ├─▶ ■ fct_orders
 *                     stg_customers ─┘
 */
export function upstreamArt(graph: LineageGraph, id: string, expanded = false): Segment[][] {
  const focus = graph.nodes[id]
  if (!focus) return []
  const all = upstreamOf(graph, id)
  const shown = expanded ? all : all.slice(0, 4)
  if (shown.length === 0) return [[{ text: 'no upstream nodes', dim: true }]]
  const grandOf = (one: (typeof all)[number]) => (expanded ? one.parents : one.parents.slice(0, 3))
  const w1 = Math.max(0, ...shown.flatMap(one => grandOf(one).map(node => label(node).length)))
  const w2 = Math.max(...shown.map(one => label(one.node).length))
  const rows: Segment[][] = []
  const parentRows: number[] = []
  for (const one of shown) {
    const grands = grandOf(one)
    const hidden = one.parents.length - grands.length
    const count = Math.max(1, grands.length + (hidden > 0 ? 1 : 0))
    const middle = Math.floor((count - 1) / 2)
    for (let r = 0; r < count; r++) {
      const row: Segment[] = []
      const isGrand = r < grands.length
      const lastIndex = count - 1
      if (grands.length > 0 || hidden > 0) {
        if (isGrand) row.push({ text: label(grands[r]!), node: grands[r]!.id }, { text: pad(label(grands[r]!), w1) })
        else if (r === grands.length && hidden > 0) row.push({ text: `+${hidden} more`.padEnd(w1), dim: true })
        else row.push({ text: ' '.repeat(w1) })
        const mark =
          count === 1 ? '─' : r === middle ? (r === 0 ? '┬' : r === lastIndex ? '┴' : '┼') : r === 0 ? '┐' : r === lastIndex ? '┘' : '┤'
        row.push({ text: ` ─${mark}${r === middle ? '─▶ ' : '   '}`, dim: true })
      } else if (w1 > 0) {
        row.push({ text: ' '.repeat(w1 + 6) })
      }
      if (r === middle) {
        row.push({ text: label(one.node), node: one.node.id }, { text: pad(label(one.node), w2) })
        parentRows.push(rows.length)
      } else {
        row.push({ text: ' '.repeat(w2) })
      }
      rows.push(row)
    }
  }
  const first = parentRows[0]!
  const last = parentRows[parentRows.length - 1]!
  const middle = parentRows[Math.floor((parentRows.length - 1) / 2)]!
  rows.forEach((row, g) => {
    if (g < first || g > last) return
    const isParent = parentRows.includes(g)
    let mark: string
    if (parentRows.length === 1) mark = '─'
    else if (g === middle) mark = g === first ? '┬' : g === last ? '┴' : '┼'
    else if (isParent) mark = g === first ? '┐' : g === last ? '┘' : '┤'
    else mark = '│'
    row.push({ text: `${isParent ? ' ─' : '  '}${mark}${g === middle ? '─▶ ' : ''}`, dim: true })
    if (g === middle) row.push({ text: '■ ', color: 'warning' }, { text: focus.name, color: 'warning', bold: true })
  })
  if (all.length > shown.length) rows.push([{ text: `+${all.length - shown.length} more upstream · [u] to show`, dim: true }])
  return rows
}

/**
 * Downstream as the pane draws it: one row per direct child, with what reads that child.
 *
 *   ■ fct_orders ─▶ fct_revenue_daily ─▶ ◆ Exec Revenue
 *                ─▶ mart_cohort_ltv   ─▶ ◆ Cohort LTV
 *                ─▶ 9 more models
 */
export function downstreamArt(graph: LineageGraph, id: string, expanded = false): Segment[][] {
  const focus = graph.nodes[id]
  if (!focus) return []
  const kids = (one: string) =>
    (graph.children[one] ?? []).map(child => graph.nodes[child]).filter((node): node is GraphNode => !!node && !isTest(node, node.id))
  const direct = kids(id)
  if (direct.length === 0) return [[{ text: '■ ', color: 'warning' }, { text: focus.name, color: 'warning', bold: true }, { text: ' nothing reads this model', dim: true }]]
  // Children that lead somewhere first: their reach is what a change risks.
  const ranked = [...direct].sort((a, b) => kids(b.id).length - kids(a.id).length || a.name.localeCompare(b.name))
  const shown = expanded ? ranked : ranked.slice(0, ranked.length > 4 ? 3 : 4)
  const width = Math.max(...shown.map(node => label(node).length))
  const indent = ' '.repeat(focus.name.length + 2)
  const rows: Segment[][] = shown.map((child, i) => {
    const row: Segment[] =
      i === 0 ? [{ text: '■ ', color: 'warning' }, { text: focus.name, color: 'warning', bold: true }] : [{ text: indent }]
    row.push(
      { text: ' ─▶ ', dim: true },
      { text: label(child), node: child.id, color: child.type === 'exposure' ? 'suggestion' : undefined },
    )
    const next = kids(child.id)
    if (next.length > 0) {
      row.push({ text: pad(label(child), width) }, { text: ' ─▶ ', dim: true })
      const exposures = next.filter(node => node.type === 'exposure')
      const models = next.filter(node => FOLLOWABLE.has(node.type))
      const parts: Segment[][] = exposures.slice(0, 2).map(node => [{ text: label(node), node: node.id, color: 'suggestion' }])
      if (exposures.length > 2) parts.push([{ text: `+${exposures.length - 2} dashboards`, color: 'suggestion' }])
      if (models.length === 1) parts.push([{ text: models[0]!.name, node: models[0]!.id }])
      else if (models.length > 1) parts.push([{ text: `${models.length} more models`, dim: true }])
      // Semantic models, metrics and saved queries read the child too.
      const others = next.length - exposures.length - models.length
      if (others > 0) parts.push([{ text: `${others} other node${others === 1 ? '' : 's'}`, dim: true }])
      parts.forEach((part, at) => {
        if (at > 0) row.push({ text: ', ', dim: true })
        row.push(...part)
      })
    }
    return row
  })
  if (ranked.length > shown.length) {
    const rest = ranked.slice(shown.length)
    const models = rest.filter(node => FOLLOWABLE.has(node.type)).length
    const others = rest.length - models
    rows.push([
      { text: indent },
      { text: ' ─▶ ', dim: true },
      { text: [models ? `${models} more model${models === 1 ? '' : 's'}` : '', others ? `${others} more` : ''].filter(Boolean).join(', '), dim: true },
    ])
  }
  return rows
}

/** The dbt integration's model lineage in a dbt_lineage answer, as sent or inside its metadata. */
export function modelLineageOf(value: unknown): any | null {
  const candidates = [value, (value as any)?.structuredContent]
  return candidates.find(one => (one as any)?.focus && Array.isArray((one as any)?.columnLineage)) ?? null
}
