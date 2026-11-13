// Profile CTEs: /profile-ctes [model] times each CTE of a dbt model, one count query per CTE (each
// recomputes the CTEs before it), and lists them slowest first in a pane.
//
// altimate-code's `dbt_cte_profile` does one thing per call: without `cte` it lists the CTEs, with
// `cte` it times one. This file drives the loop, so the pane fills live and Stop works between
// calls (a query already running cannot be cancelled). It runs only when asked, never on an edit,
// because every CTE is a warehouse query.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, RenderElement, ToolCallResult } from 'claude-code'

import type { CteProfileState, CteRow, CteTier } from '../../types'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import { later, runTool } from '../altimate-cli'
import { setStatusPart } from '../status-line'
import type { BandUi, FeatureContext } from './index'

const PANE = 'altimate-cte-profile'
const PANE_TITLE = 'Profile CTEs'
const PANE_SIZE = { columns: 90, rows: 24 }
const COMMAND = 'profile-ctes'
const TOOL = 'dbt_cte_profile'
/** A count query can run long on a big model; each call gets this much before it is given up on. */
const QUERY_BUDGET_MS = 300_000
/** The listing is a file read; it gets the default budget. */
const NEEDS_NEWER = 'Profile CTEs needs a newer altimate-code (one with the dbt_cte_profile tool): update it with `npm i -g @altimateai/altimate-code`.'

const stateAtom = atom({ plugin: 'altimate-code', key: 'cteProfile' } as const, null as CteProfileState | null)

// Per conversation: the model last read or edited (what a bare /profile-ctes profiles) and the result
// Claude has not been handed yet.
let lastModelPath: string | null = null
let pendingContext: string | null = null

/**
 * Hot at half the largest marginal time or more, warm at a fifth, else cool; all cool when no CTE added
 * any time. The rules dbt Power User uses.
 */
export function classifyTiers(marginals: readonly number[]): CteTier[] {
  const max = Math.max(0, ...marginals)
  if (max === 0) return marginals.map(() => 'cool')
  return marginals.map(ms => (ms / max >= 0.5 ? 'hot' : ms / max >= 0.2 ? 'warm' : 'cool'))
}

/** Marginal times and tiers for the rows timed so far; a row's marginal time is what it adds over the last timed row of its clause. */
export function withTiers(rows: readonly CteRow[]): CteRow[] {
  const previous = new Map<number, number>()
  const marginals = new Map<number, number>()
  rows.forEach((row, i) => {
    if (row.status !== 'done' || row.queryMs === undefined) return
    marginals.set(i, Math.max(0, row.queryMs - (previous.get(row.clause) ?? 0)))
    previous.set(row.clause, row.queryMs)
  })
  const timed = [...marginals.keys()]
  const tiers = classifyTiers(timed.map(i => marginals.get(i)!))
  return rows.map((row, i) => {
    const at = timed.indexOf(i)
    return at < 0 ? row : { ...row, marginalMs: marginals.get(i)!, tier: tiers[at] }
  })
}

/** The rows as the pane shows them: timed ones slowest first, then the rest in source order. */
export function slowestFirst(rows: readonly CteRow[]): CteRow[] {
  const timed = rows.filter(row => row.marginalMs !== undefined)
  const rest = rows.filter(row => row.marginalMs === undefined)
  return [...timed.sort((a, b) => b.marginalMs! - a.marginalMs!), ...rest]
}

function ms(value: number | undefined): string {
  return value === undefined ? '' : `${Math.round(value).toLocaleString('en-US')} ms`
}

/** The result as one note for Claude. */
export function summaryOf(state: CteProfileState): string {
  const timed = slowestFirst(state.rows).filter(row => row.marginalMs !== undefined)
  const lines = timed.map(row => `- ${row.name} (line ${row.line}): +${ms(row.marginalMs)} (${row.tier}), ${ms(row.queryMs)} in total, ${row.rows ?? 0} rows`)
  const failed = state.rows.filter(row => row.status === 'failed').map(row => `- ${row.name} (line ${row.line}): ${row.error ?? 'failed'}`)
  const left = state.rows.filter(row => row.status === 'pending').length
  return [
    `CTE profile of ${state.model}${state.status === 'stopped' ? ` (stopped, ${left} CTE${left === 1 ? '' : 's'} not timed)` : ''}, slowest first. Each time is the CTE's own part: the count query's wall time minus the one before it.`,
    ...lines,
    ...(failed.length ? ['Failed:', ...failed] : []),
  ].join('\n')
}

async function setState($: EngineInterface, change: (prev: CteProfileState) => CteProfileState) {
  await update($, stateAtom, prev => (prev ? change(prev) : prev))
}

async function say($: EngineInterface, message: string) {
  await update($, stateAtom, (prev): CteProfileState => ({ model: prev?.model ?? '', status: 'failed', rows: prev?.rows ?? [], message }))
}

/** A tool this CLI does not have, or still has as the placeholder. */
function missingTool(text: string): boolean {
  return /Unknown tool|not implemented/i.test(text)
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: PANE_TITLE, ...PANE_SIZE, focus: true, closeOnEscape: true })
}

/** The model the command names, else the one last read or edited. */
function modelFor(argument: string): string | null {
  const named = argument.trim()
  if (named) return named
  return lastModelPath
}

async function profile($: EngineInterface, model: string) {
  const listed = await runTool($, TOOL, { model }, { cliOnly: true }).catch(error => ({ ok: false, text: String(error), metadata: null as any }))
  const list = Array.isArray(listed.metadata?.ctes) ? (listed.metadata.ctes as { name: string; line: number; clause: number }[]) : null
  if (!listed.ok || !list) {
    await say($, missingTool(listed.text) ? NEEDS_NEWER : listed.text || `Could not list the CTEs of ${model}.`)
    return
  }
  if (list.length === 0) {
    await update($, stateAtom, (): CteProfileState => ({ model, status: 'done', rows: [], message: `${model} has no CTEs.` }))
    return
  }
  await update($, stateAtom, (): CteProfileState => ({
    model,
    status: 'running',
    rows: list.map(one => ({ name: one.name, line: one.line, clause: one.clause, status: 'pending' as const })),
  }))

  for (let i = 0; i < list.length; i++) {
    // Stop ends the run between queries; one already running is waited for.
    if ((await read($, stateAtom))?.status === 'stopping') break
    await setStatusPart($, 'cteProfile', `profiling CTEs ${i + 1}/${list.length}`)
    await setState($, prev => ({ ...prev, rows: prev.rows.map((row, at) => (at === i ? { ...row, status: 'running' as const } : row)) }))
    const until = (await $.clock.now()) + QUERY_BUDGET_MS
    const timed = await runTool($, TOOL, { model, cte: list[i]!.name }, { write: true, until }).catch(error => ({ ok: false, text: String(error), metadata: null as any }))
    const queryMs = timed.ok && typeof timed.metadata?.queryMs === 'number' ? (timed.metadata.queryMs as number) : undefined
    await setState($, prev =>
      ({
        ...prev,
        rows: withTiers(
          prev.rows.map((row, at) =>
            at !== i
              ? row
              : queryMs === undefined
                ? { ...row, status: 'failed' as const, error: missingTool(timed.text) ? NEEDS_NEWER : timed.text || 'no answer' }
                : { ...row, status: 'done' as const, queryMs, rows: Number(timed.metadata?.rows) || 0 },
          ),
        ),
      }),
    )
    // A refusal that every later CTE would meet too ends the run: no further queries.
    if (queryMs === undefined && missingTool(timed.text)) break
  }

  const final = await read($, stateAtom)
  if (!final) return
  const status = final.rows.some(row => row.status === 'pending') ? 'stopped' : final.rows.every(row => row.status === 'failed') ? 'failed' : 'done'
  const finished = { ...final, status, rows: final.rows.map(row => (row.status === 'running' ? { ...row, status: 'pending' as const } : row)) } as CteProfileState
  await update($, stateAtom, () => finished)
  await setStatusPart($, 'cteProfile', null)
  if (finished.rows.some(row => row.status === 'done')) {
    pendingContext = summaryOf(finished)
    const slowest = slowestFirst(finished.rows)[0]
    $.ui.toast(`◆ profile-ctes · ${finished.model}: slowest is ${slowest?.name} (+${ms(slowest?.marginalMs)})`, { timeoutMs: 8000 })
  }
}

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  on('command.run', { command: COMMAND }, async ($, e) => {
    const model = modelFor(e.args)
    const current = await read($, stateAtom)
    if (current && (current.status === 'running' || current.status === 'stopping' || current.status === 'listing')) {
      await openPane($).catch(() => {})
      return { text: `A CTE profile of ${current.model} is already running; the pane has a Stop button.` }
    }
    if (!model) return { text: 'Name a model: /profile-ctes <model>, or read or edit one first.' }
    await update($, stateAtom, (): CteProfileState => ({ model, status: 'listing', rows: [] }))
    try {
      await openPane($)
    } catch (error) {
      return { text: `Could not open Profile CTEs: ${String(error)}` }
    }
    // The command answers now; the queries go on and the pane fills in.
    later($, () => profile($, model))
    return { text: `Profiling the CTEs of ${model}: each one is a warehouse query, the pane shows them as they finish.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, stateAtom)
    if (!state) return <Text dimColor>Run /profile-ctes &lt;model&gt; to time a model's CTEs.</Text>
    const running = state.status === 'running' || state.status === 'listing'
    const done = state.rows.filter(row => row.status === 'done' || row.status === 'failed').length
    const colour = { hot: 'error', warm: 'warning', cool: 'success' } as const
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{state.model}</Text>
          <Text dimColor>
            {state.status === 'listing' && 'Listing the CTEs…'}
            {state.status === 'running' && `Timing CTE ${Math.min(done + 1, state.rows.length)} of ${state.rows.length}…`}
            {state.status === 'stopping' && 'Stopping after the running query…'}
            {state.status === 'stopped' && `Stopped: ${done} of ${state.rows.length} timed.`}
            {state.status === 'done' && state.rows.length > 0 && `${state.rows.length} CTEs timed, slowest first.`}
          </Text>
        </Box>
        {state.message && <Text color="suggestion">{state.message}</Text>}
        <Box flexDirection="column">
          {slowestFirst(state.rows).map(row => (
            <Text key={`${row.clause}-${row.name}-${row.line}`} color={row.tier ? colour[row.tier] : row.status === 'failed' ? 'error' : undefined} dimColor={row.status === 'pending'}>
              {row.status === 'running' && '… '}
              {row.status === 'failed' && '✗ '}
              {row.name} · line {row.line}
              {row.marginalMs !== undefined && ` · +${ms(row.marginalMs)} (${row.tier}) · ${ms(row.queryMs)} in total · ${row.rows} rows`}
              {row.status === 'failed' && ` · ${row.error}`}
            </Text>
          ))}
        </Box>
        <Box>
          {running && <Button key="cte-stop" label="Stop" onPress={() => later($, () => setState($, prev => ({ ...prev, status: 'stopping' })))} />}
          {!running && state.rows.some(row => row.status === 'done') && (
            <Button key="cte-send" label="Tell Claude" onPress={() => later($, () => $.prompt.submit({ text: `${summaryOf(state)}\n\nWhich CTE is worth optimizing first, and how?` }))} />
          )}
        </Box>
      </Box>
    )
  })
}

/** After the session started: the place to register commands. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  lastModelPath = null
  pendingContext = null
  await $.command.register({ name: COMMAND, description: "Time each CTE of a dbt model, slowest first (one warehouse query per CTE)" })
}

export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

/** After the turn's answer; `out` is what the turn ended with. */
export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {}

export async function sessionEnd($: EngineInterface, e: Args<'session.end'>) {
  lastModelPath = null
  pendingContext = null
}

/** This feature's line in the band, under the lineage line; null when there is nothing to say. */
export async function bandLine($: EngineInterface, ui: BandUi): Promise<RenderElement | null> {
  const state = await read($, stateAtom)
  if (!state || (state.status !== 'running' && state.status !== 'stopping')) return null
  const done = state.rows.filter(row => row.status === 'done' || row.status === 'failed').length
  const { Box, Button, Text } = ui
  return (
    <Box>
      <Text dimColor>◆ profiling CTEs of {state.model}: {done}/{state.rows.length} · </Text>
      <Button key="cte-band-stop" plain label="Stop" onPress={() => later($, () => setState($, prev => ({ ...prev, status: 'stopping' })))} />
    </Box>
  )
}

/** The command to run in place of `e.command`; null keeps it. */
export async function bashRewrite($: EngineInterface, e: BashCall): Promise<string | null> {
  return null
}

/** `{ deny }` refuses the Bash call; null lets it run. */
export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  return null
}

/** The result of a finished profile reaches Claude with the next tool result, once. */
function handOver(): ContextLines {
  const note = pendingContext
  pendingContext = null
  return note ? [note] : undefined
}

export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {
  return handOver()
}

/** `file.before` holds the text from before the edit only when `editReadsBefore` is true. */
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {
  return handOver()
}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {
  // Never runs on its own: this only remembers the model a bare /profile-ctes means.
  if (/\.sql$/i.test(file.path)) lastModelPath = file.path
  return undefined
}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
