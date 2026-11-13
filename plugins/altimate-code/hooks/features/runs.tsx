// Runs: every dbt command Claude runs, with its results, in /runs.
//
// After a Bash call that ran dbt, the last run's `dbt_run_results` is read and recorded once per
// invocation (up to 50 runs per session folder, in `$.store`); `/runs` lists them in a pane, where a run can be
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
export const MAX_ROWS = 50
/** A stored message is cut to this many characters. */
export const MAX_MESSAGE = 300
/** The store's 4 MiB is shared by every feature of the plugin: the runs stay under a quarter of it, in bytes. */
export const MAX_STORE_BYTES = 1_000_000
/** Rows the pane draws for one run. */
const SHOWN_ROWS = 40
/** Models named in the line Claude gets, each at most this long. */
const NAMED = 5
const NAME_LENGTH = 80
/** The most the tool call may be held for. */
const READ_MS = 5000
/** A file's modification time is only so exact. */
const CLOCK_SLACK_MS = 1000

/** The dbt commands that write run_results.json. */
const WRITES_RESULTS = new Set(['build', 'run', 'test', 'seed', 'snapshot', 'compile', 'retry', 'clone'])
const PASSED = new Set(['success', 'pass', 'warn'])
const SKIPPED = new Set(['skipped', 'no-op'])

const runsAtom = atom({ plugin: 'altimate-code', key: 'runs' } as const, null, { shape: 'runs-1' })

/** What `dbt_run_results` returns, as the plugin reads it. */
export type RunView = {
  found?: boolean
  projectDir?: string | null
  invocationId: string | null
  command: string | null
  elapsedSec: number | null
  completedAt: string | null
  total: number
  passed: number
  failed: number
  skipped: number
  results: RunRow[]
}

/** The store's runs: session folder → newest first. */
type Held = Record<string, RunRecord[]>

const isFailure = (status: string) => !PASSED.has(status) && !SKIPPED.has(status)

/** Names come from the artifact; Claude gets them as plain identifiers, never as free text. */
const safeName = (name: string) => name.replace(/[^\w.-]/g, '_').slice(0, NAME_LENGTH)

// ---------------------------------------------------------------------------------------------------
// Which dbt command wrote the results, and where it ran
// ---------------------------------------------------------------------------------------------------

/** Where a shell command runs: the session folder, moved by each `cd` before the invocation. */
const CD = /(?:^|[;&|(\n]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/gm

function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/') || '/'
}

function moved(command: string, from: string): string {
  let dir = from
  for (const match of command.matchAll(CD)) {
    const target = match[1]!.replace(/^['"]|['"]$/g, '')
    dir = normalize(target.startsWith('/') ? target : `${dir}/${target}`)
  }
  return dir
}

const quote = (path: string) => (/^[\w./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`)

/** A leading `NAME=value` that holds a secret is replayed as `NAME="$NAME"`: the value is never stored. */
const SECRET_ASSIGNMENT = /(^|\s)([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASS|PASSWORD|PWD|KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/gi
const redact = (head: string) => head.replace(SECRET_ASSIGNMENT, (_all, space: string, name: string) => `${space}${name}="$${name}"`)

/** The flags `dbt retry` does not take from the run it retries. */
const VALUE = `"[^"]*"|'[^']*'|\\S+`
const KEPT_FLAGS = new RegExp(`(?:^|\\s)((?:--(?:project-dir|profiles-dir|target-path|target|profile)(?:=(?:${VALUE})|\\s+(?:${VALUE})))|(?:-t\\s+(?:${VALUE})))`, 'g')
const PROJECT_DIR_FLAG = /(?:^|\s)--project-dir(?:=|\s+)("[^"]+"|'[^']+'|\S+)/

/** One dbt invocation that may have written the results. */
export type Invocation = {
  subcommand: string
  /** What Re-run fills in: `cd` to the folder it ran in, the command as written, a secret's value left out. */
  commandLine: string
  /** `dbt retry` with the launcher, the environment and the folder flags the command had. */
  retryLine: string
  /** A folder of the project the command ran in: where it ran, or the one `--project-dir` names. */
  projectDir: string
}

/** The dbt invocations of `command` that write run_results.json, in order. */
export function resultsInvocations(command: string, root: string, cwd: string = root): Invocation[] {
  return parseDbtCommand(command)
    .filter(one => one.subcommand !== null && WRITES_RESULTS.has(one.subcommand))
    .map(one => {
      const subcommand = one.subcommand!
      const dir = moved(command.slice(0, one.start), cwd)
      const body = command.slice(one.subcommandEnd - subcommand.length, one.end)
      const flagged = PROJECT_DIR_FLAG.exec(body)?.[1]?.replace(/^['"]|['"]$/g, '')
      const projectDir = flagged ? normalize(flagged.startsWith('/') ? flagged : `${dir}/${flagged}`) : dir
      // Always the folder: the session's shell may have moved by the time Re-run is pressed.
      const where = `cd ${quote(dir)} && `
      const head = redact(command.slice(one.start, one.subcommandEnd - subcommand.length))
      const kept = [...body.matchAll(KEPT_FLAGS)].map(match => match[1]!.trim())
      return {
        subcommand,
        commandLine: `${where}${head}${body}`.trim(),
        retryLine: `${where}${head}retry${kept.length ? ` ${kept.join(' ')}` : ''}`.trim(),
        projectDir,
      }
    })
}

/**
 * The invocation that wrote a file whose `args.which` is `written`: the last one of that subcommand
 * (`dbt run && dbt test` that stopped after the run wrote the run's file), else a retry.
 */
export function writer(invocations: readonly Invocation[], written: string | null): Invocation | null {
  if (written === null) return invocations[invocations.length - 1] ?? null
  return [...invocations].reverse().find(one => one.subcommand === written) ?? invocations.find(one => one.subcommand === 'retry') ?? null
}

// ---------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------

/** One run as it is kept: the counts of every node, the rows failures first, each message cut. */
export function toRecord(view: RunView, invocation: Pick<Invocation, 'commandLine' | 'retryLine'>): RunRecord | null {
  const completedAt = view.completedAt ?? ''
  const id = view.invocationId ?? (completedAt || null)
  if (!id) return null
  const rows = [...view.results.filter(row => isFailure(row.status)), ...view.results.filter(row => !isFailure(row.status))]
  return {
    id,
    project: view.projectDir ?? '',
    commandLine: invocation.commandLine,
    retryLine: invocation.retryLine,
    command: view.command ?? 'dbt',
    elapsedSec: view.elapsedSec,
    completedAt,
    total: view.total,
    passed: view.passed,
    failed: view.failed,
    skipped: view.skipped,
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

/** The bytes `text` takes as UTF-8, which is what the store's limit counts. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      at++
    } else bytes += 3
  }
  return bytes
}

/** `held` cut to MAX_STORE_BYTES: the oldest run of the folder with the most runs goes first. */
export function fitStore(held: Held): Held {
  const next: Held = { ...held }
  while (utf8Length(JSON.stringify(next)) > MAX_STORE_BYTES) {
    const biggest = Object.keys(next).sort((a, b) => next[b]!.length - next[a]!.length)[0]
    if (!biggest) break
    next[biggest] = next[biggest]!.slice(0, -1)
    if (next[biggest]!.length === 0) delete next[biggest]
  }
  return next
}

/** The line Claude gets: "build: 41 ok, 2 errors: stg_orders, fct_sales". */
export function summaryLine(run: RunRecord): string {
  const names = run.rows.filter(row => isFailure(row.status)).slice(0, NAMED).map(row => safeName(row.name))
  const more = run.failed > names.length ? ` and ${run.failed - names.length} more` : ''
  return [
    `${safeName(run.command)}: ${run.passed} ok`,
    run.failed > 0 ? `${run.failed} error${run.failed === 1 ? '' : 's'}: ${names.join(', ')}${more}` : null,
    run.skipped > 0 ? `${run.skipped} skipped` : null,
  ]
    .filter(part => part !== null)
    .join(', ')
}

/** The prompt a Re-run fills: the command in a fence. */
const asked = (command: string) => `Run this command:\n\`\`\`\n${command}\n\`\`\``

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

/** The Bash calls in flight that run dbt: when each started, by tool-use id (else the command). */
const started = new Map<string, { at: number; cwd: string }>()
const startKey = (e: BashCall) => (e as { tool_use_id?: string }).tool_use_id ?? e.command

/** Store updates one after another, so two recordings never overwrite each other's runs. */
let storing: Promise<unknown> = Promise.resolve()
const serially = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = storing.then(work, work)
  storing = run.catch(() => {})
  return run
}

const readable = (metadata: unknown): RunView | null => {
  const view = metadata as RunView | null
  return view && Array.isArray(view.results) && typeof view.total === 'number' && typeof view.failed === 'number' ? view : null
}

/** Reads the last run's results and records it when this call wrote them; the line for Claude, or null. */
async function record($: EngineInterface, e: BashCall): Promise<string | null> {
  const began = started.get(startKey(e))
  started.delete(startKey(e))
  const root = await $.session.root()
  if (began === undefined) return null
  const invocations = resultsInvocations(e.command, root, began.cwd)
  const last = invocations[invocations.length - 1]
  if (!last) return null
  const here = invocations.filter(one => one.projectDir === last.projectDir)
  const until = (await $.clock.now()) + READ_MS
  // The CLI's answer carries the rows: the plugin's MCP server offers only a fixed set of tools.
  const result = await runTool($, 'dbt_run_results', { project_dir: last.projectDir }, { until, cliOnly: true })
  const view = result.ok ? readable(result.metadata) : null
  if (!view || view.found === false) return null
  // A file older than the call is one this call did not write (dbt stopped before it ran anything).
  if (!view.completedAt || Date.parse(view.completedAt) < began.at - CLOCK_SLACK_MS) return null
  const written = writer(here, view.command)
  if (!written) return null
  const run = toRecord(view, written)
  if (!run) return null
  const line = await serially(async () => {
    const all = await held($)
    const runs = all[root] ?? []
    // The same file as the last recording: nothing new was written.
    if (runs.find(one => one.project === run.project)?.id === run.id) return null
    const next = fitStore({ ...all, [root]: withRun(runs, run) })
    await $.store.set(STORE_KEY, next)
    await update($, runsAtom, prev => (prev?.root === root ? { ...prev, runs: next[root] ?? [] } : prev))
    return summaryLine(run)
  })
  return line
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
    const latest = runs.find(one => one.project === open.project)?.id === open.id
    return (
      <Box key="runs" flexDirection="column">
        <Box>
          <Button key="runs-back" label="Back" onPress={() => show(null)} />
          <Button key="runs-rerun" label="Re-run" onPress={() => fill(asked(open.commandLine))} />
          {latest && failed.length > 0 ? (
            <Button key="runs-retry" label="Re-run failed" onPress={() => fill(asked(open.retryLine))} />
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
        {open.total > rows.length ? <Text dimColor>and {open.total - rows.length} more nodes</Text> : null}
      </Box>
    )
  })
}

/** After the session started: registers /runs and loads the project's runs. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  await $.command.register({ name: COMMAND, description: 'Show the dbt commands Claude ran, with their results' })
  await load($, await $.session.root())
}

/** Also called for a subagent's turns, which carry `e.agentId`. */
export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

/** After the turn's answer; `out` is what the turn ended with. Also called for a subagent's turns (`e.agentId`). */
export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {}

export async function sessionEnd($: EngineInterface, e: Args<'session.end'>) {}

/** This feature's line in the band, under the lineage line; null when there is nothing to say. */
export async function bandLine($: EngineInterface, ui: BandUi): Promise<RenderElement | null> {
  return null
}

/** The command to run in place of `e.command`; null keeps it. */
export async function bashRewrite($: EngineInterface, e: BashCall): Promise<string | null> {
  if (resultsInvocations(e.command, '').length === 0) return null
  started.set(startKey(e), { at: await $.clock.now(), cwd: await $.session.cwd() })
  // A call that never reaches bashAfter (refused, cancelled) leaves its entry: only the newest are kept.
  while (started.size > 50) started.delete(started.keys().next().value as string)
  return null
}

/**
 * `{ deny }` refuses the Bash call; null lets it run. A gate that throws is logged and the call runs:
 * a gate that must hold the call when its own check fails catches that failure and returns `{ deny }`.
 */
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
