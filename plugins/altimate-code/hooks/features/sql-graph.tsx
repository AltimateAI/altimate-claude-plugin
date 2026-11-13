// SQL graph: /sql-graph lists a model's CTEs, joins and filters.
//
// The plugin calls each function below at its moment, in the order features/index.ts fixes; one with
// nothing to do stays a no-op. This feature's own hooks (its commands and panes, each under a matcher
// no other part uses) go in `register`. The events the whole plugin shares (session start and end,
// turns, Bash and file tool calls, the band) come through the other functions, since a plugin hooks
// each of those once. The status-line part is set with `setStatusPart($, 'sqlGraph', text)`.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, RenderElement, ToolCallResult } from 'claude-code'

import type { SqlGraphState, SqlGraphView } from '../../types'
import { later, runTool, within } from '../altimate-cli'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { BandUi, FeatureContext } from './index'

const PANE = 'altimate-sql-graph'
const PANE_TITLE = 'SQL graph'
const COMMAND = 'sql-graph'
// How long /sql-graph waits for the graph before it replies without it; the pane shows it when it lands.
const COMMAND_WAIT_MS = 2_000
// The compile, the warehouse metadata read and the backend call, with the dbt adapter's start: its own budget.
const TOOL_BUDGET_MS = 150_000
const PANE_SIZE = { columns: 100, rows: 30 }

const stateAtom = atom({ plugin: 'altimate-code', key: 'sqlGraph' } as const, null as SqlGraphState | null, { shape: 'sql-graph-1' })

const EMPTY: SqlGraphState = { lastModel: null, shown: null }

/** The model a SQL file under a dbt project holds, by its file name; null for a file that is no model's. */
export function modelOfPath(file: string): string | null {
  const parts = file.split(/[\\/]/)
  const name = parts.pop() ?? ''
  if (!/\.sql$/i.test(name) || parts.some(part => /^(macros|tests|analyses|target|dbt_packages|dbt_modules|snapshots)$/i.test(part))) return null
  return name.replace(/\.sql$/i, '') || null
}

/** How many CTEs a model's SQL defines: `with a as (…), b as (…)`; comments and strings are not read. */
export function cteCount(sql: string): number {
  const bare = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
  return [...bare.matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)(?:"[^"]+"|`[^`]+`|\w+)\s+as\s*(?:not\s+materialized\s+|materialized\s+)?\(/gi)].length
}

/** The graph's nodes in dependency order: a node comes after everything that feeds it; ties keep the backend's order. */
export function orderNodes(graph: SqlGraphView): SqlGraphView['nodes'] {
  const names = new Set(graph.nodes.map(node => node.name))
  const pending = new Map<string, number>()
  const feeds = new Map<string, string[]>()
  for (const [from, to] of graph.edges) {
    if (!names.has(from) || !names.has(to) || from === to) continue
    pending.set(to, (pending.get(to) ?? 0) + 1)
    feeds.set(from, [...(feeds.get(from) ?? []), to])
  }
  const done = new Set<string>()
  const ordered: SqlGraphView['nodes'] = []
  const byName = new Map(graph.nodes.map(node => [node.name, node]))
  // Repeated passes in the backend's order: a cycle (which SQL cannot have) falls out as the rest, unsorted.
  while (ordered.length < graph.nodes.length) {
    const ready = graph.nodes.filter(node => !done.has(node.name) && (pending.get(node.name) ?? 0) === 0)
    const batch = ready.length ? ready : graph.nodes.filter(node => !done.has(node.name))
    for (const node of batch) {
      done.add(node.name)
      ordered.push(node)
      for (const to of feeds.get(node.name) ?? []) pending.set(to, (pending.get(to) ?? 1) - 1)
    }
    if (!ready.length) break
  }
  return ordered.length === byName.size ? ordered : graph.nodes
}

/** The inputs of a node: the names with an edge into it. */
export function inputsOf(graph: SqlGraphView, name: string): string[] {
  return graph.edges.filter(([, to]) => to === name).map(([from]) => from)
}

async function merge($: EngineInterface, change: (prev: SqlGraphState) => SqlGraphState) {
  await update($, stateAtom, prev => change(prev ?? EMPTY))
}

async function showing($: EngineInterface, model: string, change: Partial<NonNullable<SqlGraphState['shown']>>) {
  // An answer for a model the pane has since moved off is dropped.
  await merge($, prev => (prev.shown?.model === model ? { ...prev, shown: { ...prev.shown, ...change } } : prev))
}

/** Asks the tool for the model's graph and puts the answer, or why there is none, in the pane. */
async function load($: EngineInterface, model: string): Promise<boolean> {
  await merge($, prev => ({ ...prev, shown: { model, graph: null, loading: true, message: null, selected: null } }))
  try {
    const until = (await $.clock.now()) + TOOL_BUDGET_MS
    // The tool starts the dbt adapter, so it needs write permission: it goes through the CLI.
    const result = await runTool($, 'dbt_sql_graph', { model }, { write: true, until })
    const meta = result.metadata as { success?: boolean; nodes?: SqlGraphView['nodes']; edges?: SqlGraphView['edges'] } | null
    if (!result.ok || !meta?.success || !Array.isArray(meta.nodes) || !Array.isArray(meta.edges)) {
      await showing($, model, { loading: false, message: result.text || `No SQL graph for ${model}.` })
      return false
    }
    await showing($, model, { loading: false, graph: { nodes: meta.nodes, edges: meta.edges } })
    return true
  } catch (error) {
    await showing($, model, { loading: false, message: `No SQL graph for ${model}: ${String(error)}` })
    return false
  }
}

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  on('command.run', { command: COMMAND }, async ($, e) => {
    const asked = e.args.trim()
    const model = asked || (await read($, stateAtom))?.lastModel || ''
    if (!model) return { text: 'Read or edit a dbt model, or run /sql-graph <model>.' }
    try {
      await $.ui.open({ id: PANE, title: PANE_TITLE, ...PANE_SIZE, focus: true, closeOnEscape: true })
    } catch (error) {
      return { text: `Could not open the SQL graph: ${String(error)}` }
    }
    // One backend call and one warehouse metadata read, per command, never per edit.
    const landed = await within($, COMMAND_WAIT_MS, load($, model))
    if (landed === null) return { text: `The SQL graph for ${model} is loading; the pane shows it when it is ready.` }
    return { text: landed ? `The SQL graph for ${model} is open.` : ((await read($, stateAtom))?.shown?.message ?? `No SQL graph for ${model}.`) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = (await read($, stateAtom))?.shown
    if (!shown) {
      return (
        <Box key="sql-graph" flexDirection="column">
          <Text key="title" bold>SQL graph</Text>
          <Text key="hint" dimColor>Run /sql-graph &lt;model&gt;.</Text>
        </Box>
      )
    }
    if (shown.loading) {
      return (
        <Box key="sql-graph" flexDirection="column">
          <Text key="title" bold>SQL graph · {shown.model}</Text>
          <Text key="hint" dimColor>Compiling the model and asking the Altimate backend…</Text>
        </Box>
      )
    }
    if (!shown.graph) {
      return (
        <Box key="sql-graph" flexDirection="column">
          <Text key="title" bold>SQL graph · {shown.model}</Text>
          <Text key="hint" dimColor>{shown.message ?? `No SQL graph for ${shown.model}.`}</Text>
        </Box>
      )
    }
    const graph = shown.graph
    const nodes = orderNodes(graph)
    const chosen = nodes.find(node => node.name === shown.selected)
    const select = (name: string) => later($, () => showing($, shown.model, { selected: name }))
    return (
      <Box key="sql-graph" flexDirection="column">
        <Text key="title" bold>
          {`SQL graph · ${shown.model} · ${nodes.length} nodes`}
        </Text>
        {nodes.map(node => {
          const from = inputsOf(graph, node.name)
          const text = `${node.name} (${node.type}) · ${node.columns.length} ${node.columns.length === 1 ? 'column' : 'columns'}${from.length ? ` · from ${from.join(', ')}` : ''}`
          return <Button key={`node-${node.name}`} label={`${node.name === shown.selected ? '▸' : ' '} ${text}`} onPress={() => select(node.name)} />
        })}
        {chosen ? (
          <Box key="sql" flexDirection="column" marginTop={1}>
            <Text key="node" bold>{chosen.name}</Text>
            <Text key="text">{chosen.sql || '(no SQL)'}</Text>
          </Box>
        ) : (
          <Text key="hint" dimColor>Press a row to see its SQL.</Text>
        )}
      </Box>
    )
  })
}

/** After the session started: the place to register commands. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  await update($, stateAtom, () => EMPTY)
  await $.command.register({
    name: COMMAND,
    description: "Show a dbt model's CTEs, joins and filters as a graph beside the chat",
    argumentHint: '[model]',
  })
}

export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

/** After the turn's answer; `out` is what the turn ended with. */
export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {}

export async function sessionEnd($: EngineInterface, e: Args<'session.end'>) {
  await update($, stateAtom, () => EMPTY)
}

/** This feature's line in the band, under the lineage line; null when there is nothing to say. */
export async function bandLine($: EngineInterface, ui: BandUi): Promise<RenderElement | null> {
  return null
}

/** The command to run in place of `e.command`; null keeps it. */
export async function bashRewrite($: EngineInterface, e: BashCall): Promise<string | null> {
  return null
}

/** `{ deny }` refuses the Bash call; null lets it run. */
export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  return null
}

export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {}

/** `file.before` holds the text from before the edit only when `editReadsBefore` is true. */
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {
  if (!modelOfPath(file.path)) return
  const sql = await $.fs.read(file.path).catch(() => null)
  const count = sql === null ? 0 : cteCount(sql)
  // One line; the backend is asked only when the person runs /sql-graph.
  if (count > 0) return [`${count} ${count === 1 ? 'CTE' : 'CTEs'} · /sql-graph`]
}

/** The model Claude last read or edited is the one /sql-graph shows without a name. */
export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {
  const model = modelOfPath(file.path)
  if (model) await merge($, prev => (prev.lastModel === model ? prev : { ...prev, lastModel: model }))
}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
