import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type {
  ColumnLineage,
  ColumnReachView,
  ImpactView,
  LineageFocus,
  LineageGraph,
  WarehouseView,
} from '../types'
import { later, parseJson, runAltimate } from './altimate-cli'
import {
  FOLLOWABLE,
  buildGraph,
  columnsFromMetadata,
  describeGraph,
  downstreamArt,
  findModel,
  impactOf,
  parseDbtLineage,
  reachFromMetadata,
  type Segment,
  subgraph,
  toSvg,
  touchedColumns,
  upstreamArt,
  warehouseEdges,
} from './lineage-graph'

const PANE = 'altimate-lineage'
const PANE_TITLE = 'Altimate lineage'
const COMMAND = 'lineage'
// The plugin's own MCP server, by its key in .mcp.json.
const SERVER_KEY = 'altimate-code'
const DBT_LINEAGE = /__dbt_lineage$/
const WAREHOUSE_TOOL = /^mcp__(.+)__((?:databricks_)?table_lineage)$/
// $.fs.read refuses files over 4 MiB; bigger manifests are read through altimate-code's tools.
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const TOOL_TIMEOUT_MS = 60_000
// How long an edit waits for the column reach before it goes ahead without it.
const HOLD_MS = 6_000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

const focusAtom = atom({ plugin: 'altimate-code', key: 'lineageFocus' } as const, null, { shape: 'lineage-focus-1' })
const graphAtom = atom({ plugin: 'altimate-code', key: 'lineageGraph' } as const, null, { shape: 'lineage-graph-1' })
const columnsAtom = atom({ plugin: 'altimate-code', key: 'lineageColumns' } as const, null, { shape: 'lineage-columns-1' })
const columnAtom = atom({ plugin: 'altimate-code', key: 'lineageColumn' } as const, null as string | null)
const reachAtom = atom({ plugin: 'altimate-code', key: 'lineageReach' } as const, null, { shape: 'lineage-reach-1' })
const warehouseAtom = atom({ plugin: 'altimate-code', key: 'lineageWarehouse' } as const, null, { shape: 'lineage-warehouse-1' })
const expandedAtom = atom({ plugin: 'altimate-code', key: 'lineageExpanded' } as const, { up: false, down: false })
const impactAtom = atom({ plugin: 'altimate-code', key: 'lineageImpact' } as const, null, { shape: 'lineage-impact-1' })
const messageAtom = atom({ plugin: 'altimate-code', key: 'lineageMessage' } as const, null as string | null)
const loadingAtom = atom({ plugin: 'altimate-code', key: 'lineageLoading' } as const, false)
const bandHiddenAtom = atom({ plugin: 'altimate-code', key: 'isLineageBandHidden' } as const, false)

// Caches, rebuilt from the manifest file after a reload.
let manifestCache: { path: string; mtimeMs: number; graph: LineageGraph } | null = null
// Graphs altimate-code returned for a manifest over 4 MiB, by manifest, revision and model.
const toolsCache = new Map<string, { graph: LineageGraph; id: string; columns: ColumnLineage | null } | null>()
// Per conversation: reset on session start and end (a /clear ends one).
let paneOpened = false
const contextGiven = new Set<string>()

const LENS_COLOR: Record<string, string> = {
  Original: 'success',
  Alias: 'suggestion',
  Transformation: 'warning',
  'Non select': 'inactive',
  'Not sure': 'subtle',
}
const SEVERITY_COLOR: Record<ImpactView['severity'], string> = {
  SAFE: 'success',
  LOW: 'suggestion',
  MEDIUM: 'warning',
  HIGH: 'error',
}

/** Resolves with the work's value, or null once `ms` pass or it fails. */
function within<T>($: EngineInterface, ms: number, work: Promise<T>): Promise<T | null> {
  return new Promise(resolve => {
    let settled = false
    const settle = (value: T | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    $.clock.after(ms, () => settle(null))
    work.then(settle, () => settle(null))
  })
}

/** One focus: the model in one manifest revision. Async answers for another are dropped. */
const sameFocus = (a: LineageFocus | null, b: LineageFocus | null) =>
  !!a && !!b && a.model === b.model && a.manifest === b.manifest && a.mtimeMs === b.mtimeMs

/** `a/./b/../c` → `a/c`, so two spellings of one manifest are one focus and one cache entry. */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/') || '/'
}

const dirname = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || path
const relative = (root: string, path: string) => path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')

/** The dbt project above a file or folder: the closest folder holding dbt_project.yml. */
async function projectRoot($: EngineInterface, start: string, isFile: boolean): Promise<string | null> {
  let dir = isFile ? dirname(start) : start
  for (let i = 0; i < 40; i++) {
    if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

let serverName: string | null = null
let connectFailedAt = -Infinity
const CONNECT_RETRY_MS = 60_000

/** The plugin's MCP server as $.mcp.call names it, or null when it is not connected (CLI mode); a failure is retried after a minute. */
async function mcpServer($: EngineInterface): Promise<string | null> {
  if (serverName) return serverName
  const now = await $.clock.now()
  if (now - connectFailedAt < CONNECT_RETRY_MS) return null
  const connected = await $.mcp.connect(SERVER_KEY).catch(() => null)
  serverName = connected?.isConnected ? connected.server : null
  if (!serverName) connectFailedAt = now
  return serverName
}

const elapsed = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)
const firstLine = (text: string | undefined) => text?.split('\n').find(line => line.trim())?.trim().slice(0, 200) ?? null

// SQL files a shell command reads (`cat models/x.sql`, `sed -n 1,40p x.sql`): Claude often reads that way.
const SQL_IN_COMMAND = /(?:^|[\s'"=])((?:\/|\.{0,2}\/)?[\w./-]+\.sql)(?=$|[\s'";|&)])/g
function sqlFilesIn(command: string, cwd: string): string[] {
  return [...command.matchAll(SQL_IN_COMMAND)].map(match => {
    const file = match[1]!
    return file.startsWith('/') ? file : `${cwd.replace(/[\\/]+$/, '')}/${file.replace(/^\.\//, '')}`
  })
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  const blocks = Array.isArray(content) ? content : Array.isArray((content as any)?.content) ? (content as any).content : []
  return blocks
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
}

/**
 * Runs one altimate-code data tool: through the plugin's MCP server when it is connected (no
 * permission prompt, structured content when the build sends it), else `altimate tool run --json`.
 * `cliOnly` goes straight to the CLI, whose --json carries the whole metadata; a structured result
 * the server left out for size is fetched that way too.
 */
async function runTool($: EngineInterface, name: string, args: Record<string, unknown>, cliOnly = false) {
  const server = cliOnly ? null : await mcpServer($)
  if (server) {
    try {
      const result = await $.mcp.call(server, name, args)
      let text = textOf(result.content)
      // A long result comes back as a preview plus a link to the full text.
      const link = result.content.find((block: any) => block?.type === 'resource_link' && String(block.uri).startsWith('file://')) as
        | { uri: string }
        | undefined
      if (link) text = await $.fs.read(decodeURIComponent(new URL(link.uri).pathname)).catch(() => text)
      // Claude Code hands a tool's structured content over as one JSON text block in place of the
      // text; the structured content carries the text report as `report`.
      const structured = (result.structuredContent ?? (text.trim().startsWith('{') ? parseJson(text) : null)) as any
      if (structured?.truncated !== true) {
        return { metadata: structured, text: typeof structured?.report === 'string' ? structured.report : text, ok: !result.isError }
      }
    } catch {
      // Fall through to the CLI: the server may have gone away mid-session.
    }
  }
  const result = await runAltimate($, ['tool', 'run', name, '--args', JSON.stringify(args), '--json'], TOOL_TIMEOUT_MS)
  if ((result as { isStdoutTruncated?: boolean }).isStdoutTruncated) {
    return { metadata: null as any, text: `${name}'s answer was larger than the 4 MiB a plugin can read`, ok: false }
  }
  const data = parseJson<{ status?: string; output?: string; metadata?: unknown }>(result.stdout)
  return { metadata: (data?.metadata ?? null) as any, text: data?.output ?? '', ok: result.exitCode === 0 && data?.status !== 'error' }
}

/** The manifest's graph, read from the file once per change; null when the file is too big to read. */
async function readGraph($: EngineInterface, manifest: string): Promise<LineageGraph | null> {
  const stat = await $.fs.stat(manifest)
  if (manifestCache?.path === manifest && manifestCache.mtimeMs === stat.mtimeMs) return manifestCache.graph
  if (stat.size > MAX_MANIFEST_BYTES) return null
  const graph = buildGraph(JSON.parse(await $.fs.read(manifest)))
  manifestCache = { path: manifest, mtimeMs: stat.mtimeMs, graph }
  return graph
}

/**
 * For a manifest over 4 MiB: dbt_lineage with include_graph, which reads the manifest inside
 * altimate-code and returns the subgraph the pane would build itself (downstream capped at 500
 * nodes, marked `truncated`). Run through the CLI, whose --json carries the whole metadata (the MCP
 * server leaves big structured results out). Cached per manifest revision and model.
 */
async function graphFromTools($: EngineInterface, manifest: string, mtimeMs: number, model: string, path?: string) {
  // A file is looked up by its path: snapshots and versioned models do not go by the file's name.
  model = path ?? model
  const key = `${manifest}\u0000${mtimeMs}\u0000${model}`
  if (toolsCache.has(key)) return checkPath(toolsCache.get(key)!, path)
  const result = await runTool($, 'dbt_lineage', { manifest_path: manifest, model, include_graph: true }, true)
  const graph = result.metadata?.graph as LineageGraph | undefined
  const id: string | undefined = result.metadata?.model_unique_id ?? undefined
  if (!result.ok && !id) return null
  if (id && !graph?.nodes?.[id]) throw new Error('needs an altimate-code build whose dbt_lineage supports include_graph')
  const built = id && graph ? { graph, id, columns: columnsFromMetadata(result.metadata) } : null
  // One revision per manifest: a recompile replaces the old graphs.
  for (const old of toolsCache.keys()) if (old.startsWith(`${manifest}\u0000`) && !old.startsWith(`${manifest}\u0000${mtimeMs}\u0000`)) toolsCache.delete(old)
  toolsCache.set(key, built)
  return checkPath(built, path)
}

/** A file is that model only when its path is the model's: a macro or analysis of the same name is not. */
function checkPath<T extends { graph: LineageGraph; id: string } | null>(built: T, path?: string): T | null {
  return built && (!path || built.graph.nodes[built.id]?.path === path) ? built : null
}

type FollowInput = {
  file?: string
  model?: string
  column?: string | null
  columns?: ColumnLineage | null
  /** Focus the pane: /lineage and presses. */
  open?: boolean
  /** Claude's own call led here: the pane opens unfocused, once a conversation, and only failures the user can act on are shown. */
  auto?: boolean
  /** Re-read the manifest (and, unless a large manifest's cached columns stand, the column lineage) even when the model is unchanged. */
  refresh?: boolean
  /** The manifest a tool call named (Claude's own dbt_lineage call): its project is the one to follow. */
  manifest?: string
}

/** Points the pane at a model (by file, name or unique_id) and loads its graph, columns, reach and warehouse lineage. */
async function follow($: EngineInterface, input: FollowInput): Promise<boolean> {
  // What Claude's own reads run into outside a project (a package's SQL, a stray .sql) is not news.
  const isPackage = !!input.file && /[\\/]dbt_(?:packages|modules)[\\/]/.test(input.file)
  const say = async (text: string, always = false) => {
    if (!input.auto || (always && !isPackage)) await update($, messageAtom, () => text)
  }
  const current = await read($, focusAtom)
  const sessionRoot = await $.session.root().catch(() => '.')
  const given = input.manifest ? normalize(/^([\\/]|[A-Za-z]:)/.test(input.manifest) ? input.manifest : `${sessionRoot}/${input.manifest}`) : null
  // A tool call's manifest names the project; a model named without a file belongs to the project
  // (and manifest) already followed, else to the session's.
  const named = given ?? (!input.file && current ? current.manifest : null)
  const root = given
    ? dirname(dirname(given))
    : input.file
      ? await projectRoot($, input.file, true)
      : (current?.root ?? (await projectRoot($, sessionRoot, false)))
  if (!root) {
    await say('Not inside a dbt project: no dbt_project.yml above this folder.')
    return false
  }
  const manifest = named ?? `${root}/target/manifest.json`
  const stat = await $.fs.stat(manifest).catch(() => null)
  if (!stat) {
    await say('No dbt manifest: run `dbt parse` or `dbt compile` to see lineage.', true)
    return false
  }
  if (input.refresh) {
    manifestCache = null
    for (const key of toolsCache.keys()) if (key.startsWith(`${manifest}\u0000`)) toolsCache.delete(key)
  }
  const wanted = input.file ? relative(root, input.file) : input.model!
  const began = await $.clock.now()
  let graph: LineageGraph | null
  try {
    graph = await readGraph($, manifest)
  } catch {
    await say(`Could not read ${relative(root, manifest) || manifest}: is dbt still writing it? Press r to retry.`, true)
    return false
  }
  let id = graph ? findModel(graph, wanted) : null
  let via: LineageFocus['via'] = 'manifest'
  let columns = input.columns ?? null
  if (!graph) {
    const name = input.file ? (wanted.split('/').pop() ?? wanted).replace(/\.sql$/, '') : wanted
    let failure: string | null = null
    const built = await graphFromTools($, manifest, stat.mtimeMs, name, input.file ? wanted : undefined).catch(error => {
      failure = String(error?.message ?? error)
      return null
    })
    if (failure) {
      await say(`The manifest is over 4 MiB; reading it through altimate-code ${failure}.`, true)
      return false
    }
    graph = built?.graph ?? null
    id = built?.id ?? null
    columns ??= built?.columns ?? null
    via = 'tools'
  }
  if (!graph || !id) {
    await say(`No dbt model matches "${wanted}" in the manifest.`)
    return false
  }
  const readMs = Math.round((await $.clock.now()) - began)
  // The same unique_id in another project, or after a recompile, is a different focus.
  const isNew = current?.model !== id || current.manifest !== manifest || current.mtimeMs !== stat.mtimeMs || !!input.refresh
  const node = graph.nodes[id]!
  await update($, focusAtom, () => ({ model: id!, root, manifest, via, readMs, mtimeMs: stat.mtimeMs }))
  await update($, graphAtom, () => (via === 'manifest' ? subgraph(graph!, id!) : graph!))
  await update($, messageAtom, () => null)
  if (isNew) {
    if (current?.model !== id) await update($, expandedAtom, () => ({ up: false, down: false }))
    await update($, columnsAtom, () => null)
    await update($, reachAtom, () => null)
    await update($, warehouseAtom, () => null)
    if (current?.model !== id) await update($, columnAtom, () => null)
    if (current?.model !== id) $.ui.log(`lineage-pane · following ${node.name} →`)
    $.ui.log(`lineage-pane · ${relative(root, manifest)} · ${elapsed(readMs)}${via === 'tools' ? ' · via altimate-code' : ' · offline'}`)
  }
  if (input.column !== undefined) await update($, columnAtom, () => input.column ?? null)
  if (input.open || (!paneOpened && input.auto)) {
    paneOpened = true
    await $.ui.open({ id: PANE, title: PANE_TITLE, ...(input.open ? { focus: true as const } : {}), closeOnEscape: true }).catch(() => {})
  }
  later($, () => loadDetails($, columns, isNew))
  return true
}

/** Column lineage, then the selected column's reach, then warehouse lineage: each redraws as it lands. */
async function loadDetails($: EngineInterface, preloaded: ColumnLineage | null, isNew: boolean) {
  const focus = await read($, focusAtom)
  const graph = await read($, graphAtom)
  const node = focus && graph ? graph.nodes[focus.model] : null
  if (!focus || !node) return
  await update($, loadingAtom, () => true)
  try {
    if (preloaded) await update($, columnsAtom, () => preloaded)
    else if (isNew || !(await read($, columnsAtom))) {
      const began = await $.clock.now()
      const result = await runTool($, 'dbt_lineage', { manifest_path: focus.manifest, model: focus.model }).catch(() => null)
      if (!sameFocus(await read($, focusAtom), focus)) return
      const columns = result?.ok ? (columnsFromMetadata(result.metadata) ?? (result.text ? parseDbtLineage(result.text) : null)) : null
      await update($, columnsAtom, () => columns)
      if (!result?.ok) await update($, messageAtom, () => `dbt_lineage failed: ${firstLine(result?.text) ?? 'altimate-code did not answer'}`)
      const ms = Math.round((await $.clock.now()) - began)
      if (columns) $.ui.log(`lineage-pane · dbt_lineage(${node.name}) · ${columns.columns.length} columns · ${elapsed(ms)}`)
    }
    if ((await read($, columnAtom)) && (isNew || !(await read($, reachAtom)))) await loadReach($)
    if (isNew) await loadWarehouse($)
  } finally {
    await update($, loadingAtom, () => false)
  }
}

/** The downstream models and dashboards that read the selected column (impact_analysis' column reach). */
async function loadReach($: EngineInterface) {
  const focus = await read($, focusAtom)
  const graph = await read($, graphAtom)
  const column = await read($, columnAtom)
  const node = focus && graph ? graph.nodes[focus.model] : null
  if (!focus || !node || !column) return
  await update($, reachAtom, () => null)
  if (node.type !== 'model') {
    await update($, messageAtom, () => 'Column reach starts from a model; a snapshot is traced when it is downstream of one.')
    return
  }
  const result = await runTool($, 'impact_analysis', {
    manifest_path: focus.manifest,
    model: focus.model,
    column,
    change_type: 'modify',
  }).catch(() => null)
  if (!sameFocus(await read($, focusAtom), focus) || (await read($, columnAtom)) !== column) return
  const reach = result?.ok ? reachFromMetadata(result.metadata, node.name, column) : null
  await update($, reachAtom, () => reach)
  if (!result?.ok) await update($, messageAtom, () => `impact_analysis failed: ${firstLine(result?.text) ?? 'altimate-code did not answer'}`)
  else if (reach) $.ui.log(`lineage-pane · column ${column} · impact_analysis(${node.name}, column: ${column}) · read by ${reach.models.length} models`)
  else if (result.metadata?.column_reach_error) await update($, messageAtom, () => `Column reach failed: ${firstLine(String(result.metadata.column_reach_error))}`)
  else if (result.metadata && result.metadata.severity === undefined) await update($, messageAtom, () => `impact_analysis: ${firstLine(result.text) ?? 'no answer'}`)
  else await update($, messageAtom, () => 'Column reach needs an altimate-code build whose impact_analysis reports column_reach.')
}

/** Warehouse lineage for the model's relation from a connected SaaS MCP server's table_lineage, when there is one. */
async function loadWarehouse($: EngineInterface) {
  const focus = await read($, focusAtom)
  const graph = await read($, graphAtom)
  const node = focus && graph ? graph.nodes[focus.model] : null
  if (!node?.relation) return
  const tools = await $.tool.list().catch(() => [])
  const found = tools
    .map(tool => WAREHOUSE_TOOL.exec(tool.name))
    .find((match): match is RegExpExecArray => !!match && !match[1]!.startsWith('plugin_altimate-code'))
  if (!found) return
  const [, server, tool] = found as unknown as [string, string, string]
  const began = await $.clock.now()
  const result = await within(
    $,
    15_000,
    $.mcp.call(server, tool, { filters: { table: [node.relation], direction: ['downstream'], depth: ['2'] }, limit: 50 }),
  )
  if (!result || result.isError || !sameFocus(await read($, focusAtom), focus)) return
  const body = result.structuredContent ?? parseJson(textOf(result.content))
  const records = (body as any)?.data ?? body
  const view: WarehouseView = { server, tool, table: node.relation, edges: warehouseEdges(body), complete: records?.truncated !== true && !records?.next_cursor }
  await update($, warehouseAtom, () => view)
  const ms = Math.round((await $.clock.now()) - began)
  $.ui.log(`lineage-pane · ${server} · ${tool}(${node.relation}) · ${elapsed(ms)}`)
}

async function openPane($: EngineInterface) {
  paneOpened = true
  await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
}

/** The text an edit replaces and the text it writes: Edit's strings, MultiEdit's pairs, or a Write's whole file. */
async function editTexts($: EngineInterface, e: any): Promise<{ before: string[]; after: string[] }> {
  if (e.tool === 'Edit') return { before: [String(e.old_string ?? '')], after: [String(e.new_string ?? '')] }
  if (e.tool === 'MultiEdit') {
    const edits: any[] = Array.isArray(e.edits) ? e.edits : []
    return { before: edits.map(one => String(one?.old_string ?? '')), after: edits.map(one => String(one?.new_string ?? '')) }
  }
  return { before: [await $.fs.read(String(e.file_path)).catch(() => '')], after: [String(e.content ?? '')] }
}

type ImpactNote = { key: string; toast: string; context: string; view: ImpactView }

/**
 * Before an edit to a model's SQL: what reads the model, and, when the edit changes one of its
 * columns, which downstream models and dashboards read that column. Shown as a toast, then added to
 * Claude's context with the edit's result.
 */
async function impactFirst($: EngineInterface, e: any, file: string): Promise<ImpactNote | null> {
  const root = await projectRoot($, file, true)
  if (!root) return null
  const manifest = `${root}/target/manifest.json`
  let graph = await readGraph($, manifest).catch(() => null)
  let id = graph ? findModel(graph, relative(root, file)) : null
  if (!graph) {
    const stat = await $.fs.stat(manifest).catch(() => null)
    const name = (file.split(/[\\/]/).pop() ?? file).replace(/\.sql$/i, '')
    const built = stat ? await graphFromTools($, manifest, stat.mtimeMs, name, relative(root, file)).catch(() => null) : null
    graph = built?.graph ?? null
    id = built?.id ?? null
  }
  if (!graph || !id) return null
  const node = graph.nodes[id]!
  const counts = impactOf(graph, id)
  const downstream = counts.direct + counts.transitive
  if (downstream === 0 && counts.exposures.length === 0) return null
  const known = (await read($, focusAtom))?.model === id ? ((await read($, columnsAtom))?.columns.map(one => one.name) ?? []) : []
  const { before, after } = await editTexts($, e)
  const column = touchedColumns(before, after, [...new Set([...known, ...node.columns])])[0] ?? null

  let reach: ColumnReachView | null = null
  if (column) {
    const began = await $.clock.now()
    const result = await within($, HOLD_MS, runTool($, 'impact_analysis', { manifest_path: manifest, model: id, column, change_type: 'modify' }))
    reach = result?.ok ? reachFromMetadata(result.metadata, node.name, column) : null
    const ms = Math.round((await $.clock.now()) - began)
    if (reach) $.ui.log(`impact-first · impact_analysis(${node.name}.${column}) · ${elapsed(ms)}`)
  }

  const target = column && reach ? `${node.name}.${column}` : node.name
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  // What the engine could not settle keeps the count a lower bound, never a confident zero.
  const unsettled = reach ? reach.uncertain.length + reach.untraced.length + (reach.truncated ? 1 : 0) : 0
  const atLeast = unsettled > 0 ? 'at least ' : ''
  // Dashboards on models that may read the column count too: a rename breaks a filter for certain.
  const dashboards = reach ? [...reach.exposures, ...reach.uncertainExposures] : counts.exposures
  const toast = reach
    ? `${target} is read by ${atLeast}${plural(reach.models.length, 'model')} and ${plural(dashboards.length, 'dashboard')}`
    : `${target} feeds ${graph.truncated ? 'at least ' : ''}${plural(downstream, 'model')} and ${plural(dashboards.length, 'dashboard')}`
  const toastText = `◆ impact-first · ${toast}${dashboards.length ? ` · ${dashboards.slice(0, 3).join(' · ')}` : ''}`

  const lines = [`Altimate lineage for ${target}, read from the dbt manifest before this edit:`]
  if (reach) {
    const named = reach.models.slice(0, 15).map(one => (one.columns.length ? `${one.name} (${one.columns.join(', ')})` : one.name))
    lines.push(`- read by ${atLeast}${plural(reach.models.length, 'downstream model')}${named.length ? `: ${named.join(', ')}${reach.models.length > 15 ? ', …' : ''}` : ''}`)
    if (reach.exposures.length) lines.push(`- dashboards on them: ${reach.exposures.join(', ')}`)
    if (reach.uncertainExposures.length) lines.push(`- dashboards on models that may read it: ${reach.uncertainExposures.join(', ')}`)
    if (reach.truncated) lines.push('- the trace stopped at its model limit; more models may read it')
    if (reach.uncertain.length) lines.push(`- may also read it: ${reach.uncertain.slice(0, 10).map(one => `${one.name} (${one.reason})`).join(', ')}`)
    if (reach.untraced.length) lines.push(`- could not be traced: ${reach.untraced.slice(0, 10).map(one => `${one.name} (${one.reason})`).join(', ')}`)
  }
  lines.push(
    `- ${node.name} feeds ${graph.truncated ? 'at least ' : ''}${plural(downstream, 'downstream model')} in all (${counts.direct} direct, ${counts.transitive} transitive), ${plural(counts.tests, 'test')}${counts.exposures.length ? ` and ${plural(counts.exposures.length, 'exposure')} (${counts.exposures.join(', ')})` : ''}.`,
  )
  lines.push('Keep these consumers working, or tell the user which of them this edit changes.')
  return {
    key: `${e.agentId ?? 'main'}\u0000${manifest}\u0000${id}\u0000${column ?? ''}`,
    toast: toastText,
    context: lines.join('\n'),
    view: {
      model: node.name,
      column: reach ? column : null,
      severity: counts.severity,
      direct: counts.direct,
      transitive: counts.transitive,
      tests: counts.tests,
      exposures: dashboards,
      readers: reach ? reach.models.length : null,
      unsettled,
      truncated: !!graph.truncated,
    },
  }
}

/** dbt_lineage's answer as a ToolResult row carries it: structured content, or its text. */
function lineageFromOutput(output: unknown): ColumnLineage | null {
  const structured = columnsFromMetadata((output as any)?.structuredContent ?? output)
  if (structured) return structured
  let text = textOf(output)
  if (text.trim().startsWith('{')) {
    const json = parseJson<any>(text)
    const fromJson = columnsFromMetadata(json)
    if (fromJson) return fromJson
    // A result the server cut for size carries only its report.
    text = typeof json?.report === 'string' ? json.report : ''
  }
  const parsed = text.includes('Column Mappings:') ? parseDbtLineage(text) : null
  // Nothing parsed means nothing known: let the pane fetch the lineage itself.
  return parsed && (parsed.columns.length > 0 || parsed.edges.length > 0) ? parsed : null
}

/** Registers /lineage; called from the plugin's one session.start hook. */
export async function startLineage($: EngineInterface) {
  // A new session opens the pane on its first follow again and owes Claude the context again.
  paneOpened = false
  contextGiven.clear()
  await $.command.register({
    name: COMMAND,
    description: 'Show dbt lineage for a model beside the chat: upstream, downstream, columns and column reach',
    argumentHint: '<model>[.column]',
  })
}

type Ui = { Box: any; Button: any; Text: any }

/** The band line after Claude edits a model; drawn by the plugin's one band hook. */
export async function lineageBand($: EngineInterface, ui: Ui): Promise<RenderElement | null> {
  const impact = await read($, impactAtom)
  if (!impact || (await read($, bandHiddenAtom))) return null
  const { Box, Button, Text } = ui
  const target = impact.column ? `${impact.model}.${impact.column}` : impact.model
  // One Text, so a narrow band wraps it as a line, not word by word in each piece.
  return (
    <Box key="lineage-band" flexDirection="column">
      <Text>
        <Text color="warning">⚠ Impact </Text>
        <Text bold>{target}</Text>
        <Text dimColor> (modify) </Text>
        <Text color={SEVERITY_COLOR[impact.severity]} bold>
          {impact.severity}
        </Text>
        <Text dimColor>
          {'  '}direct {impact.direct} · transitive {impact.transitive}{impact.truncated ? '+' : ''} · tests {impact.tests}
          {impact.readers !== null ? ` · read by ${impact.unsettled ? 'at least ' : ''}${impact.readers} models` : ''}
          {impact.exposures.length ? ` · ${impact.exposures.length} dashboards` : ''}
        </Text>
      </Text>
      <Box>
        <Button key="lineage-open" label="Open lineage" onPress={() => later($, () => openPane($))} />
        <Button key="lineage-dismiss" label="Dismiss" onPress={() => update($, bandHiddenAtom, () => true)} />
      </Box>
    </Box>
  )
}

function drawRow(ui: Ui, $: EngineInterface, graph: LineageGraph, segments: Segment[], key: string) {
  const { Box, Button, Text } = ui
  return (
    <Box key={key} flexDirection="row">
      {segments.map((one, i) =>
        one.node && FOLLOWABLE.has(graph.nodes[one.node]?.type ?? '') ? (
          <Button key={`${key}-${one.node}`} plain label={one.text} onPress={() => later($, async () => void (await follow($, { model: one.node! })))} />
        ) : (
          <Text key={`${key}-${i}`} color={one.color} dimColor={one.dim} bold={one.bold}>
            {one.text}
          </Text>
        ),
      )}
    </Box>
  )
}

/** The lineage hooks whose events no other part of the plugin hooks. */
export function registerLineage(on: On) {
  // A new user turn gets the lineage note again (its context may have been compacted since), once.
  on('session.end', async ($, e, next) => {
    paneOpened = false
    contextGiven.clear()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's turn starting does not clear the main conversation's context.
    if (!(e as { agentId?: string }).agentId) contextGiven.clear()
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [model, column] = e.args.trim().split('.')
    const current = await read($, focusAtom)
    if (!model && !current) {
      await update($, messageAtom, () => 'Read or edit a dbt model, or run /lineage <model>[.column].')
    }
    try {
      await openPane($)
    } catch (error) {
      return { text: `Could not open Altimate lineage: ${String(error)}` }
    }
    if (model) later($, async () => void (await follow($, { model, column: column ?? null, open: true })))
    else if (current) later($, () => loadDetails($, null, false))
    return { text: `Altimate lineage${model ? ` for ${e.args.trim()}` : ''} opened in the side pane.` }
  })

  // Follow the model Claude reads or edits; before an edit lands, look up what it reaches.
  on('tool.call', async ($, e, next) => {
    const file = (EDIT_TOOLS.has(e.tool) || e.tool === 'Read') && 'file_path' in e ? String(e.file_path) : null
    const isSql = !!file && /\.sql$/i.test(file)
    const isEdit = isSql && EDIT_TOOLS.has(e.tool)
    const note = isEdit ? await within($, HOLD_MS + 2_000, impactFirst($, e, file!)) : null
    const result = await next(e)
    if (result.deny || result.isError) return result

    if (DBT_LINEAGE.test(e.tool) && 'model' in e) {
      const columns = lineageFromOutput((result as any).result ?? result.text)
      const manifest = typeof (e as any).manifest_path === 'string' ? String((e as any).manifest_path) : undefined
      later($, async () => void (await follow($, { model: String((e as any).model), columns, auto: true, manifest })))
    }
    if (isSql) later($, async () => void (await follow($, { file: file!, auto: true })))
    else if (e.tool === 'Bash' && 'command' in e) {
      const files = sqlFilesIn(String(e.command), await $.session.root().catch(() => '.'))
      if (files.length) later($, async () => void (await follow($, { file: files[files.length - 1]!, auto: true })))
    }
    if (note) {
      // Shown only when the lookup finished inside the hold, so the toast never trails a released edit.
      $.ui.toast(note.toast, { timeoutMs: 8000 })
      await update($, impactAtom, () => note.view)
      await update($, bandHiddenAtom, () => false)
      if (!contextGiven.has(note.key)) {
        contextGiven.add(note.key)
        $.ui.log(`impact-first · added to Claude's context: lineage for ${note.view.column ? `${note.view.model}.${note.view.column}` : note.view.model}`)
        return { ...result, context: [...(result.context ?? []), note.context] } as typeof result
      }
    }
    return result
  })

  // Claude's own dbt_lineage calls: the edges as a list colored by how each column is derived. The
  // full view (ctrl+o) keeps the original output under the list, so nothing is hidden.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!DBT_LINEAGE.test(e.props.tool) || e.props.isErrored) return next(e)
    const parsed = lineageFromOutput(e.props.output)
    if (!parsed || parsed.edges.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const direct = parsed.edges.filter(edge => edge.lineageType === 'direct')
    const indirect = parsed.edges.filter(edge => edge.lineageType === 'indirect')
    const w1 = Math.max(...direct.map(edge => edge.target.length), 4)
    const w2 = Math.max(...direct.map(edge => edge.source.length), 4)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {parsed.model} · confidence {parsed.confidence} · {parsed.columns.length} columns · {parsed.edges.length} edges
        </Text>
        {(e.props.isExpanded ? direct : direct.slice(0, 12)).map((edge, i) => (
          <Text key={`edge-${i}`}>
            {edge.target.padEnd(w1)} <Text dimColor>←</Text> {edge.source.padEnd(w2)}{'  '}
            <Text color={LENS_COLOR[edge.lens] ?? 'subtle'}>{edge.lens}</Text>
            {edge.expression ? <Text dimColor> ({edge.expression})</Text> : null}
          </Text>
        ))}
        {direct.length > 12 && !e.props.isExpanded && <Text dimColor>+ {direct.length - 12} more columns · ctrl+o for all</Text>}
        {indirect.length > 0 && (
          <Text dimColor>
            + {indirect.length} indirect (Non select): {[...new Set(indirect.map(edge => edge.source))].slice(0, 4).join(', ')}
          </Text>
        )}
        {e.props.isExpanded ? await next(e) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Svg = 'Svg' in ui ? (ui as any).Svg : null
    const focus = await read($, focusAtom)
    const graph = await read($, graphAtom)
    const columns = await read($, columnsAtom)
    const column = await read($, columnAtom)
    const reach = await read($, reachAtom)
    const warehouse = await read($, warehouseAtom)
    const expanded = await read($, expandedAtom)
    const message = await read($, messageAtom)
    const loading = await read($, loadingAtom)
    const node = focus && graph ? graph.nodes[focus.model] : null

    if (!focus || !graph || !node) {
      return (
        <Box flexDirection="column">
          <Text bold>lineage</Text>
          <Text dimColor>{message ?? 'Read or edit a dbt model, or run /lineage <model>[.column].'}</Text>
        </Box>
      )
    }

    const counts = impactOf(graph, focus.model)
    const columnNames = columns?.columns.length ? columns.columns.map(one => one.name) : node.columns
    const lensOf = (name: string) => columns?.edges.find(edge => edge.target === name && edge.lineageType === 'direct')?.lens ?? null
    const selectColumn = (name: string | null) =>
      later($, async () => {
        await update($, columnAtom, () => name)
        await update($, reachAtom, () => null)
        if (name) await loadReach($)
      })
    const nextColumn = () => {
      if (columnNames.length === 0) return
      const at = column ? columnNames.indexOf(column) : -1
      selectColumn(columnNames[(at + 1) % columnNames.length]!)
    }
    const source = focus.via === 'tools' ? 'altimate-code' : 'manifest'
    const relationNames = new Map(Object.values(graph.nodes).filter(one => one.relation).map(one => [one.relation!.toLowerCase(), one]))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>lineage · {node.name}</Text>
            <Text color="suggestion">mod · lineage-pane</Text>
          </Box>
          <Text dimColor>
            {node.path ?? node.id}
            {node.materialized ? ` · ${node.materialized}` : ''}
          </Text>
          {message && <Text color="warning">{message}</Text>}
          {columns?.note && <Text color="warning">⚠ {columns.note}</Text>}
        </Box>

        <Box flexDirection="column">
          <Text dimColor>UPSTREAM · {source}</Text>
          {upstreamArt(graph, focus.model, expanded.up).map((row, i) => drawRow(ui, $, graph, row, `up-${i}`))}
        </Box>

        <Box flexDirection="column">
          <Text dimColor>DOWNSTREAM · {source}</Text>
          {downstreamArt(graph, focus.model, expanded.down).map((row, i) => drawRow(ui, $, graph, row, `down-${i}`))}
          <Text dimColor>
            {counts.direct} direct · {counts.transitive}{graph.truncated ? '+' : ''} transitive · {counts.tests} tests ·{' '}
            <Text color={SEVERITY_COLOR[counts.severity]}>{counts.severity}</Text>
          </Text>
        </Box>

        {Svg && e.surface === 'desktop' && (
          <Svg key="lineage-svg" source={toSvg(graph, focus.model)} alt={describeGraph(graph, focus.model)} isInteractive />
        )}

        {warehouse && (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor>OBSERVED IN THE WAREHOUSE · {warehouse.server}</Text>
            {warehouse.edges.length === 0 ? (
              <Text dimColor>no warehouse lineage for {warehouse.table}</Text>
            ) : (
              warehouse.edges.slice(0, 8).map((edge, i) => {
                const table = edge.target ?? '(stage)'
                const known = edge.target ? relationNames.get(edge.target.toLowerCase()) : undefined
                return (
                  <Box key={`wh-${i}`} justifyContent="space-between">
                    <Text>{known ? known.name : table}</Text>
                    <Text dimColor>hop {edge.hop}</Text>
                  </Box>
                )
              })
            )}
            {warehouse.complete && (graph.children[focus.model] ?? [])
              .map(child => graph.nodes[child])
              .filter(child => FOLLOWABLE.has(child?.type ?? '') && child!.relation && !warehouse.edges.some(edge => edge.target?.toLowerCase() === child!.relation))
              .slice(0, 3)
              .map(child => (
                <Box key={`wh-miss-${child!.id}`} justifyContent="space-between">
                  <Text>{child!.name}</Text>
                  <Text color="error">not seen in the warehouse</Text>
                </Box>
              ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text dimColor>COLUMNS · dbt_lineage{columns ? ` · confidence ${columns.confidence}` : loading ? ' · reading…' : ''}</Text>
          {columnNames.length === 0 && <Text dimColor>  no columns known</Text>}
          {columnNames.slice(0, 12).map(name => {
            const lens = lensOf(name)
            const sources = columns?.columns.find(one => one.name === name)?.sources ?? []
            return (
              <Box key={`col-${name}`} flexDirection="row">
                <Text color={lens ? (LENS_COLOR[lens] ?? 'subtle') : 'subtle'}>{name === column ? '▸ ' : '● '}</Text>
                <Button key={`col-${name}-pick`} plain label={name} onPress={() => selectColumn(name === column ? null : name)} />
                <Text dimColor>
                  {sources.length ? ` ← ${sources.join(', ')}` : ''}
                  {lens ? `  ${lens}` : ''}
                </Text>
              </Box>
            )
          })}
          {columnNames.length > 12 && <Text dimColor>  + {columnNames.length - 12} more · [c] cycles through all</Text>}
        </Box>

        {column && (
          <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Text dimColor>COLUMN · {column}</Text>
            {reach ? (
              <Box flexDirection="column">
                <Text>
                  read by <Text color="warning">{reach.models.length} models</Text> ·{' '}
                  <Text color="warning">{reach.exposures.length} dashboards</Text>
                  {reach.truncated ? <Text dimColor> (stopped early)</Text> : null}
                </Text>
                {reach.exposures.length > 0 ? <Text dimColor>{reach.exposures.join(' · ')}</Text> : null}
                {reach.uncertainExposures.length > 0 ? (
                  <Text color="warning">
                    + {reach.uncertainExposures.length} dashboards on models that may read it: {reach.uncertainExposures.slice(0, 3).join(' · ')}
                  </Text>
                ) : null}
                {reach.uncertain.length > 0 ? (
                  <Text color="warning">
                    + {reach.uncertain.length} may read it: {reach.uncertain.slice(0, 4).map(one => one.name).join(', ')}
                  </Text>
                ) : null}
                {reach.untraced.length > 0 ? (
                  <Text color="warning">
                    {reach.untraced.length} not traced ({reach.untraced[0]!.reason}): {reach.untraced.slice(0, 4).map(one => one.name).join(', ')}
                  </Text>
                ) : null}
                {reach.models.length > 0 ? (
                  <Text dimColor>
                    {reach.models
                      .slice(0, 6)
                      .map(one => one.name)
                      .join(', ')}
                    {reach.models.length > 6 ? `, +${reach.models.length - 6}` : ''}
                  </Text>
                ) : null}
              </Box>
            ) : (
              <Text dimColor>tracing {column} through downstream SQL…</Text>
            )}
          </Box>
        )}

        <Box flexDirection="row" gap={2}>
          <Button key="lineage-up" plain hotkey="u" label="upstream" onPress={() => update($, expandedAtom, current => ({ ...current, up: !current.up }))} />
          <Button key="lineage-down" plain hotkey="d" label="downstream" onPress={() => update($, expandedAtom, current => ({ ...current, down: !current.down }))} />
          <Button key="lineage-column" plain hotkey="c" label="column" onPress={nextColumn} />
          <Button
            key="lineage-refresh"
            plain
            hotkey="r"
            label="refresh"
            onPress={() =>
              later($, async () => void (await follow($, { model: focus.model, refresh: true })))
            }
          />
          <Button
            key="lineage-ask"
            plain
            hotkey="a"
            label="ask Claude"
            onPress={() =>
              later($, async () => {
                await $.prompt.submit({ text: `Explain the lineage of ${node.name}${column ? `.${column}` : ''} and what a change to it would affect.` })
              })
            }
          />
        </Box>
      </Box>
    )
  })
}
