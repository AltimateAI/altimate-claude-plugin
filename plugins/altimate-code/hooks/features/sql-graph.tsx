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
import { projectLayout } from '../lineage-graph'
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

const stateAtom = atom({ plugin: 'altimate-code', key: 'sqlGraph' } as const, null, { shape: 'sql-graph-1' })

const EMPTY: SqlGraphState = { lastModel: null, shown: null }

// Folders at the top of a dbt project that hold no model, and build or package folders at any depth. A folder inside a model path keeps its name: `models/tests/orders.sql` is a model.
const NOT_MODEL_TOP = /^(macros|tests|analyses|analysis|snapshots|seeds)$/i
const NOT_MODEL_ANYWHERE = /^(target|dbt_packages|dbt_modules)$/i
// The most of a node's SQL the pane draws; a larger statement is cut, and says so.
const SQL_LIMIT = 20_000

/** The model a SQL file holds, by its file name; null for a file outside a dbt project's model folders. */
export async function modelOf($: EngineInterface, file: string): Promise<string | null> {
  if (!/\.sql$/i.test(file)) return null
  const path = file.replace(/\\/g, '/')
  let dir = path.slice(0, path.lastIndexOf('/'))
  let root: string | null = null
  for (let i = 0; i < 40 && dir; i++) {
    if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) {
      root = dir
      break
    }
    const cut = dir.lastIndexOf('/')
    if (cut <= 0) break
    dir = dir.slice(0, cut)
  }
  // An installed package has a dbt_project.yml of its own: its models are not this project's.
  if (!root || NOT_MODEL_ANYWHERE.test(root.split('/').slice(-2, -1)[0] ?? '')) return null
  const relative = path.slice(root.length).replace(/^\/+/, '')
  const folders = relative.split('/').slice(0, -1)
  if (folders.some(part => NOT_MODEL_ANYWHERE.test(part)) || NOT_MODEL_TOP.test(folders[0] ?? '')) return null
  const layout = projectLayout(await $.fs.read(`${root}/dbt_project.yml`).catch(() => ''))
  const inside = layout.models.some(folder => {
    const own = folder.replace(/^\.\/+/, '').replace(/^\.$/, '').replace(/\/+$/, '')
    return own === '' || relative.startsWith(`${own}/`)
  })
  return inside ? relative.slice(relative.lastIndexOf('/') + 1).replace(/\.sql$/i, '') || null : null
}

/** How many CTEs a model's SQL defines: `with a as (…), b (c) as (…)`; comments and strings are not read. */
export function cteCount(sql: string): number {
  // One pass, so a `--` inside a string and a quote inside a comment each stay where they are.
  const bare = sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|\{#[\s\S]*?#\}/g, ' ')
  return [
    ...bare.matchAll(
      /(?:\bwith\s+(?:recursive\s+)?|,\s*)(?:"[^"]+"|`[^`]+`|\w+)\s*(?:\([^)]*\)\s*)?as\s*(?:not\s+materialized\s+|materialized\s+)?\(/gi,
    ),
  ].length
}

/** Text from the repo, the CLI or the backend drawn as one line of plain characters: escape sequences and control characters out. */
function plain(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
}

/** A node's SQL as drawn: lines kept, escape sequences and other control characters out, and cut at SQL_LIMIT. */
function sqlText(sql: string): string {
  const kept = sql.slice(0, SQL_LIMIT).split('\n').map(plain).join('\n')
  return sql.length > SQL_LIMIT ? `${kept}\n… ${sql.length - SQL_LIMIT} more characters not shown` : kept
}

/** The graph's nodes in dependency order: a node comes after everything that feeds it; ties keep the backend's order. */
export function orderNodes(graph: SqlGraphView): SqlGraphView['nodes'] {
  const ids = new Set(graph.nodes.map(node => node.id))
  const pending = new Map<string, number>()
  const feeds = new Map<string, string[]>()
  for (const [from, to] of graph.edges) {
    if (!ids.has(from) || !ids.has(to) || from === to) continue
    pending.set(to, (pending.get(to) ?? 0) + 1)
    feeds.set(from, [...(feeds.get(from) ?? []), to])
  }
  const done = new Set<string>()
  const ordered: SqlGraphView['nodes'] = []
  // Repeated passes in the backend's order: a cycle (which SQL cannot have) falls out as the rest, unsorted.
  while (ordered.length < graph.nodes.length) {
    const ready = graph.nodes.filter(node => !done.has(node.id) && (pending.get(node.id) ?? 0) === 0)
    const batch = ready.length ? ready : graph.nodes.filter(node => !done.has(node.id))
    for (const node of batch) {
      done.add(node.id)
      ordered.push(node)
      for (const to of feeds.get(node.id) ?? []) pending.set(to, (pending.get(to) ?? 1) - 1)
    }
    if (!ready.length) break
  }
  return ordered.length === graph.nodes.length ? ordered : graph.nodes
}

/** The inputs of a node: the ids with an edge into it. */
export function inputsOf(graph: SqlGraphView, id: string): string[] {
  return graph.edges.filter(([, to]) => to === id).map(([from]) => from)
}

async function merge($: EngineInterface, change: (prev: SqlGraphState) => SqlGraphState) {
  await update($, stateAtom, prev => change(prev ?? EMPTY))
}

// The ask that owns the pane. Only an answer to that ask is written, so an older ask for the same model, or one
// from before a new conversation, never replaces a newer one.
let latestRequest = 0

async function showing($: EngineInterface, request: number, change: Partial<NonNullable<SqlGraphState['shown']>>) {
  await merge($, prev => (prev.shown?.request === request ? { ...prev, shown: { ...prev.shown, ...change } } : prev))
}

/** Asks the tool for the model's graph and puts the answer, or why there is none, in the pane. */
async function load($: EngineInterface, model: string): Promise<'shown' | 'failed' | 'replaced'> {
  const request = ++latestRequest
  await merge($, prev => ({ ...prev, shown: { model, request, graph: null, loading: true, message: null, selected: null } }))
  let outcome: 'shown' | 'failed' = 'failed'
  try {
    const until = (await $.clock.now()) + TOOL_BUDGET_MS
    // The tool starts the dbt adapter, so it needs write permission: it goes through the CLI.
    const result = await runTool($, 'dbt_sql_graph', { model }, { write: true, until })
    const meta = result.metadata as { success?: boolean; error?: string; nodes?: SqlGraphView['nodes']; edges?: SqlGraphView['edges'] } | null
    if (!result.ok || !meta?.success || !Array.isArray(meta.nodes) || !Array.isArray(meta.edges)) {
      await showing($, request, { loading: false, message: plain(result.text || String((meta as { error?: unknown } | null)?.error ?? '') || `No SQL graph for ${model}.`) })
    } else {
      await showing($, request, { loading: false, graph: { nodes: meta.nodes, edges: meta.edges } })
      outcome = 'shown'
    }
  } catch (error) {
    await showing($, request, { loading: false, message: plain(`No SQL graph for ${model}: ${String(error)}`) })
  }
  return (await read($, stateAtom))?.shown?.request === request ? outcome : 'replaced'
}

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  on('command.run', { command: COMMAND }, async ($, e) => {
    const asked = e.args.trim()
    const model = asked || (await read($, stateAtom))?.lastModel || ''
    if (!model) return { text: 'Read or edit a dbt model, or run /sql-graph <model>.' }
    const shownModel = plain(model)
    try {
      await $.ui.open({ id: PANE, title: PANE_TITLE, ...PANE_SIZE, focus: true, closeOnEscape: true })
    } catch (error) {
      return { text: plain(`Could not open the SQL graph: ${String(error)}`) }
    }
    // One backend call and one warehouse metadata read, per command, never per edit.
    const landed = await within($, COMMAND_WAIT_MS, load($, model))
    if (landed === null) return { text: `The SQL graph for ${shownModel} is loading; the pane shows it when it is ready.` }
    if (landed === 'replaced') return { text: `The SQL graph for ${shownModel} was replaced by a newer /sql-graph.` }
    return { text: landed === 'shown' ? `The SQL graph for ${shownModel} is open.` : ((await read($, stateAtom))?.shown?.message ?? `No SQL graph for ${shownModel}.`) }
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
          <Text key="title" bold>{`SQL graph · ${plain(shown.model)}`}</Text>
          <Text key="hint" dimColor>Compiling the model and asking the Altimate backend…</Text>
        </Box>
      )
    }
    if (!shown.graph) {
      return (
        <Box key="sql-graph" flexDirection="column">
          <Text key="title" bold>{`SQL graph · ${plain(shown.model)}`}</Text>
          <Text key="hint" dimColor>{plain(shown.message ?? `No SQL graph for ${shown.model}.`)}</Text>
        </Box>
      )
    }
    const graph = shown.graph
    const nodes = orderNodes(graph)
    const chosen = nodes.find(node => node.id === shown.selected)
    const nameOf = new Map(nodes.map(node => [node.id, node.name]))
    const select = (id: string) => later($, () => showing($, shown.request, { selected: id }))
    return (
      <Box key="sql-graph" flexDirection="column">
        <Text key="title" bold>
          {`SQL graph · ${plain(shown.model)} · ${nodes.length} nodes`}
        </Text>
        {nodes.map(node => {
          const from = inputsOf(graph, node.id).map(id => nameOf.get(id) ?? id)
          const text = `${plain(node.name)} (${plain(node.type)}) · ${node.columns.length} ${node.columns.length === 1 ? 'column' : 'columns'}${from.length ? ` · from ${from.map(plain).join(', ')}` : ''}`
          return <Button key={`node-${node.id}`} label={`${node.id === shown.selected ? '▸' : ' '} ${text}`} onPress={() => select(node.id)} />
        })}
        {chosen ? (
          <Box key="sql" flexDirection="column" marginTop={1}>
            <Text key="node" bold>{plain(chosen.name)}</Text>
            <Text key="text">{chosen.sql ? sqlText(chosen.sql) : '(no SQL)'}</Text>
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

/** Also called for a subagent's turns, which carry `e.agentId`. */
export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

/** After the turn's answer; `out` is what the turn ended with. Also called for a subagent's turns (`e.agentId`). */
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

/**
 * `{ deny }` refuses the Bash call; null lets it run. A gate that throws is logged and the call runs:
 * a gate that must hold the call when its own check fails catches that failure and returns `{ deny }`.
 */
export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  return null
}

export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {}

/** `file.before` holds the text from before the edit only when `editReadsBefore` is true. */
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {
  if (!(await modelOf($, file.path))) return
  const sql = await $.fs.read(file.path).catch(() => null)
  const count = sql === null ? 0 : cteCount(sql)
  // One line; the backend is asked only when the person runs /sql-graph.
  if (count > 0) return [`${count} ${count === 1 ? 'CTE' : 'CTEs'} · /sql-graph`]
}

/** The model Claude last read or edited is the one /sql-graph shows without a name. */
export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {
  const model = await modelOf($, file.path)
  if (model) await merge($, prev => (prev.lastModel === model ? prev : { ...prev, lastModel: model }))
}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
