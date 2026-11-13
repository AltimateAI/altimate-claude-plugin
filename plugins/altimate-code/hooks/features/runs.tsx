// Runs: every dbt command Claude runs, with its results, in /runs.
//
// After a Bash call that ran dbt, the last run's `dbt_run_results` is read and recorded once per
// invocation (up to 50 runs per project, in `$.store`); `/runs` lists them in a pane, where a run can be
// opened, re-run, or its failures re-run through the prompt.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, RenderElement, ToolCallResult } from 'claude-code'

import type { RunRecord, RunRow, RunsState } from '../../types'
import { runTool } from '../altimate-cli'
import { parseDbtCommand } from '../dbt-command'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { BandUi, FeatureContext } from './index'

const PANE = 'altimate-runs'
const PANE_TITLE = 'dbt runs'
const COMMAND = 'runs'
const PANE_SIZE = { columns: 90, rows: 30 }
const STORE_KEY = 'runs'

/** Runs kept per project. */
export const MAX_RUNS = 50
/** Rows kept per run: failures first, then the rest. */
export const MAX_ROWS = 100
/** A stored message is cut to this many characters. */
export const MAX_MESSAGE = 300
/** The whole store holds at most 4 MiB; the runs stay well under it. */
export const MAX_STORE_BYTES = 2_500_000
/** Rows the pane draws for one run. */
const SHOWN_ROWS = 40
/** Models named in the line Claude gets. */
const NAMED = 5
/** The most the tool call may be held for. */
const READ_MS = 5000

/** The dbt commands that write run_results.json. */
const WRITES_RESULTS = new Set(['build', 'run', 'test', 'seed', 'snapshot', 'compile', 'retry', 'clone'])
const PASSED = new Set(['success', 'pass', 'warn'])
const SKIPPED = new Set(['skipped', 'no-op'])

const runsAtom = atom({ plugin: 'altimate-code', key: 'runs' } as const, null as RunsState | null)

/** What `dbt_run_results` returns, as the plugin reads it. */
export type RunView = {
  found?: boolean
  invocationId: string | null
  command: string | null
  elapsedSec: number | null
  completedAt: string | null
  results: RunRow[]
}

/** The store's runs: project folder → newest first. */
type Held = Record<string, RunRecord[]>

const isFailure = (status: string) => !PASSED.has(status) && !SKIPPED.has(status)

/** The dbt invocation of `command` that wrote the results: the last one with a command that writes them. */
export function resultsInvocation(command: string) {
  const found = parseDbtCommand(command).filter(one => one.subcommand !== null && WRITES_RESULTS.has(one.subcommand))
  const last = found[found.length - 1]
  return last ? { commandLine: command.slice(last.start, last.end).trim(), retryLine: `${last.binary} retry` } : null
}

/** One run as it is kept: counts of every node, the rows failures first, each message cut. */
export function toRecord(view: RunView, commandLine: string, retryLine: string): RunRecord | null {
  const completedAt = view.completedAt ?? ''
  const id = view.invocationId ?? (completedAt || null)
  if (!id) return null
  const rows = [...view.results.filter(row => isFailure(row.status)), ...view.results.filter(row => !isFailure(row.status))]
  return {
    id,
    commandLine,
    retryLine,
    command: view.command ?? 'dbt',
    elapsedSec: view.elapsedSec,
    completedAt,
    total: view.results.length,
    passed: view.results.filter(row => PASSED.has(row.status)).length,
    failed: view.results.filter(row => isFailure(row.status)).length,
    skipped: view.results.filter(row => SKIPPED.has(row.status)).length,
    rows: rows.slice(0, MAX_ROWS).map(row => ({
      ...row,
      message: row.message === null ? null : row.message.length > MAX_MESSAGE ? `${row.message.slice(0, MAX_MESSAGE)}…` : row.message,
    })),
  }
}

/** `run` first, the older ones after it, at most MAX_RUNS; the same invocation is never kept twice. */
export function withRun(runs: readonly RunRecord[], run: RunRecord): RunRecord[] {
  return [run, ...runs.filter(one => one.id !== run.id)].slice(0, MAX_RUNS)
}

/** `held` cut to MAX_STORE_BYTES: the oldest run of the project with the most runs goes first. */
export function fitStore(held: Held): Held {
  const next: Held = { ...held }
  while (JSON.stringify(next).length > MAX_STORE_BYTES) {
    const biggest = Object.keys(next).sort((a, b) => next[b]!.length - next[a]!.length)[0]
    if (!biggest) break
    next[biggest] = next[biggest]!.slice(0, -1)
    if (next[biggest]!.length === 0) delete next[biggest]
  }
  return next
}

/** The line Claude gets: "build: 41 ok, 2 errors: stg_orders, fct_sales". */
export function summaryLine(run: RunRecord): string {
  const names = run.rows.filter(row => isFailure(row.status)).slice(0, NAMED).map(row => row.name)
  const more = run.failed > names.length ? ` and ${run.failed - names.length} more` : ''
  return [
    `${run.command}: ${run.passed} ok`,
    run.failed > 0 ? `${run.failed} error${run.failed === 1 ? '' : 's'}: ${names.join(', ')}${more}` : null,
    run.skipped > 0 ? `${run.skipped} skipped` : null,
  ]
    .filter(part => part !== null)
    .join(', ')
}

const seconds = (value: number | null) => (value === null ? '-' : `${value < 10 ? value.toFixed(1) : Math.round(value)}s`)

async function held($: EngineInterface): Promise<Held> {
  const value = await $.store.get(STORE_KEY)
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Held) : {}
}

/** The pane's runs for `root`, from the store. */
async function load($: EngineInterface, root: string, open: string | null = null) {
  const runs = (await held($))[root] ?? []
  await update($, runsAtom, () => ({ root, runs, open }))
}

/** Reads the last run's results and records it unless it is the one recorded last; the line for Claude, or null. */
async function record($: EngineInterface, e: BashCall): Promise<string | null> {
  const invocation = resultsInvocation(e.command)
  if (!invocation) return null
  const root = await $.session.root()
  const until = (await $.clock.now()) + READ_MS
  const readable = (metadata: unknown): RunView | null => {
    const view = metadata as RunView | null
    return view && Array.isArray(view.results) ? view : null
  }
  let result = await runTool($, 'dbt_run_results', {}, { until })
  let view = result.ok ? readable(result.metadata) : null
  // An MCP answer without the rows (a build that leaves structured content out): the CLI's carries them.
  if (!view && result.ok) {
    result = await runTool($, 'dbt_run_results', {}, { until, cliOnly: true })
    view = result.ok ? readable(result.metadata) : null
  }
  if (!view || view.found === false) return null
  const run = toRecord(view, invocation.commandLine, invocation.retryLine)
  if (!run) return null
  const all = await held($)
  const runs = all[root] ?? []
  // The same file as the last recording: this command wrote nothing new (it failed before it started).
  if (runs[0]?.id === run.id) return null
  const next = fitStore({ ...all, [root]: withRun(runs, run) })
  await $.store.set(STORE_KEY, next)
  const shown = await read($, runsAtom)
  if (shown?.root === root) await update($, runsAtom, () => ({ root, runs: next[root] ?? [], open: shown.open }))
  return summaryLine(run)
}

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  on('command.run', { command: COMMAND }, async $ => {
    try {
      await load($, await $.session.root())
      await $.ui.open({ id: PANE, title: PANE_TITLE, ...PANE_SIZE, focus: true, closeOnEscape: true })
    } catch (error) {
      return { text: `Could not open the dbt runs: ${String(error)}` }
    }
    return { text: 'The dbt runs are open.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, runsAtom)
    const runs = state?.runs ?? []
    const open = state?.open ? runs.find(run => run.id === state.open) : undefined
    const show = (open: string | null) => update($, runsAtom, prev => (prev ? { ...prev, open } : prev))
    const fill = (text: string) => $.prompt.fill({ text, mode: 'replace' })

    if (!open) {
      return (
        <Box key="runs" flexDirection="column">
          <Text bold>dbt runs</Text>
          {runs.length === 0 ? (
            <Text dimColor>No dbt command has run in this project yet.</Text>
          ) : (
            runs.map(run => (
              <Button
                key={`run-${run.id}`}
                label={`${run.command}  ${seconds(run.elapsedSec)}  ${run.passed}/${run.total} passed`}
                onPress={() => show(run.id)}
              />
            ))
          )}
        </Box>
      )
    }

    const failed = open.rows.filter(row => isFailure(row.status))
    const rows = open.rows.slice(0, SHOWN_ROWS)
    const latest = runs[0]?.id === open.id
    return (
      <Box key="runs" flexDirection="column">
        <Box>
          <Button key="runs-back" label="Back" onPress={() => show(null)} />
          <Button key="runs-rerun" label="Re-run" onPress={() => fill(`Run \`${open.commandLine}\``)} />
          {latest && failed.length > 0 ? (
            <Button key="runs-retry" label="Re-run failed" onPress={() => fill(`Run \`${open.retryLine}\``)} />
          ) : null}
        </Box>
        <Text bold>{open.commandLine}</Text>
        <Text dimColor>
          {open.command} · {seconds(open.elapsedSec)} · {open.passed}/{open.total} passed · {open.completedAt}
        </Text>
        {rows.map(row => (
          <Box key={`row-${row.uniqueId}`} flexDirection="column">
            <Text color={isFailure(row.status) ? 'error' : undefined}>
              {row.status} {row.name} {seconds(row.executionTimeSec)}
            </Text>
            {isFailure(row.status) && row.message ? <Text dimColor>{row.message}</Text> : null}
          </Box>
        ))}
        {open.rows.length > rows.length ? <Text dimColor>and {open.rows.length - rows.length} more</Text> : null}
      </Box>
    )
  })
}

/** After the session started: registers /runs and loads the project's runs. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  await $.command.register({ name: COMMAND, description: 'Show the dbt commands Claude ran, with their results' })
  await load($, await $.session.root())
}

export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

/** After the turn's answer; `out` is what the turn ended with. */
export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {}

export async function sessionEnd($: EngineInterface, e: Args<'session.end'>) {}

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

/** A dbt command that wrote run_results.json is recorded; Claude gets one line with its outcome. */
export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {
  const line = await record($, e)
  return line ? [line] : []
}

/** `file.before` holds the text from before the edit only when `editReadsBefore` is true. */
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
