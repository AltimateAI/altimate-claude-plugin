// Runs: every dbt command Claude runs, with its results, in /runs.
//
// After a Bash call that ran dbt, each project's last run is read with `dbt_run_results` and recorded once
// (up to 50 runs per project, in `$.store`); `/runs` lists them in a pane, where a run can be
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

/** Runs kept for each project. */
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

function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || (part === '' && out.length > 0)) continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/') || '/'
}

/** What can move the shell: `cd`, `pushd`, `popd`, and what runs other text or scripts in the same shell. */
const MOVERS = new Set(['cd', 'pushd', 'popd', 'builtin', 'command', 'eval', 'source', '.'])
/** A mover anywhere in the text, also with its quotes and escapes taken out (`c\\d`, `"c"d`): without one the folder cannot have moved. */
const MOVES = /(?:^|[^\w./-])(?:cd|pushd|popd|builtin|command|eval|source)(?![\w./-])|(?:^|[;&|(\n])[ \t]*\.[ \t]/
const mayMove = (text: string) => MOVES.test(text) || MOVES.test(text.replace(/[\\'"]/g, ''))
/** Anything that makes shell text more than plain words: quotes, expansions, grouping, redirections, pipes, comments, escapes. */
const SHELL_SYNTAX = /['"`\\$(){}<>|#&~*?[\]!]/
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case', 'esac', 'time'])

/**
 * Where the command runs after the `cd`s in `text` (what came before the dbt invocation), from `from`.
 * Only the plain form is read: statements split by `&&`, `;` or a new line, each either `cd <plain word>`
 * or plain words that cannot move the folder. Anything else around a `cd` (quotes, `$VAR`, `~`, a subshell,
 * a pipe or redirection, a comment, `if`, `cd -`, `pushd`) gives null: the folder is not guessed, the run is
 * not recorded. A `cd` that follows another command with `&&` is trusted only when the dbt invocation is
 * in the same `&&` chain, since the `cd` is skipped when that command fails.
 */
function moved(text: string, from: string): string | null {
  if (!mayMove(text)) return from
  let dir = from
  let pending = false
  let previous: 'start' | 'cd' | 'other' = 'start'
  const parts = text.split(/(&&|;|\n)/)
  // A line may continue after `&&`: the separator before the next statement is then still `&&`.
  let carried = ''
  for (let at = 0; at < parts.length; at += 2) {
    const statement = parts[at]!.trim()
    const separator = carried || (at === 0 ? '' : parts[at - 1]!)
    if (statement === '') {
      if (separator === '&&') carried = '&&'
      continue
    }
    carried = ''
    if (separator !== '&&' && pending) return null
    const words = statement.split(/\s+/)
    const first = words[0]!
    if (first === 'cd' || first === 'pushd' || first === 'popd') {
      const target = words[1]
      if (first !== 'cd' || words.length !== 2 || SHELL_SYNTAX.test(statement) || target!.startsWith('-')) return null
      dir = normalize(target!.startsWith('/') ? target! : `${dir}/${target}`)
      if (separator === '&&' && previous === 'other') pending = true
      previous = 'cd'
    } else {
      if (SHELL_SYNTAX.test(statement) || KEYWORDS.has(first) || words.some(word => MOVERS.has(word))) return null
      previous = 'other'
    }
  }
  // The invocation follows the last separator: after a `;` it is outside the `&&` chain a conditional `cd` is in.
  if (pending && parts.length > 1 && parts[parts.length - 2] !== '&&') return null
  return dir
}

const quote = (path: string) => (/^[\w./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`)

/** A leading `NAME=value` that holds a secret is replayed as `NAME="$NAME"`: the value is never stored. */
const SECRET_ASSIGNMENT = /(^|\s)((?=[A-Za-z_])[A-Za-z0-9_]*(?:SECRET|TOKEN|PASS|PASSWORD|PWD|KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/gi
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
  /** Where the command sent its artifacts when it was not the project's own target folder (`--target-path`, `DBT_TARGET_PATH`). */
  targetPath: string | null
}

/** The dbt invocations of `command` that write run_results.json, in order. */
export function resultsInvocations(command: string, root: string, cwd: string = root): Invocation[] {
  const found: Invocation[] = []
  for (const one of parseDbtCommand(command)) {
    const subcommand = one.subcommand
    if (subcommand === null || !WRITES_RESULTS.has(subcommand)) continue
    const dir = moved(command.slice(0, one.start), cwd)
    const body = command.slice(one.subcommandEnd - subcommand.length, one.end)
    const flagged = PROJECT_DIR_FLAG.exec(body)?.[1]?.replace(/^['"]|['"]$/g, '')
    // A folder that cannot be told, or a target folder the shell expands, is not guessed: the run is not recorded
    // rather than recorded for another project or replayed from another folder.
    if (dir === null || /[$`~*?[{]/.test(`${one.targetPath ?? ''}${flagged ?? ''}`)) continue
    const projectDir = flagged ? normalize(flagged.startsWith('/') ? flagged : `${dir}/${flagged}`) : dir
    // Always the folder: the session's shell may have moved by the time Re-run is pressed.
    const where = `cd ${quote(dir)} && `
    const head = redact(command.slice(one.start, one.subcommandEnd - subcommand.length))
    const kept = [...body.matchAll(KEPT_FLAGS)].map(match => match[1]!.trim())
    found.push({
      subcommand,
      commandLine: `${where}${head}${body}`.trim(),
      retryLine: `${where}${head}retry${kept.length ? ` ${kept.join(' ')}` : ''}`.trim(),
      projectDir,
      targetPath: one.targetPath,
    })
  }
  return found
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

/** Newest first by completion (a tie keeps `run` ahead), at most MAX_RUNS of each project; the same invocation is never kept twice. */
export function withRun(runs: readonly RunRecord[], run: RunRecord): RunRecord[] {
  const kept = new Map<string, number>()
  const newestFirst = [run, ...runs.filter(one => one.id !== run.id)].sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || 0)
  return newestFirst.filter(one => {
    const count = (kept.get(one.project) ?? 0) + 1
    kept.set(one.project, count)
    return count <= MAX_RUNS
  })
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

/** The Bash calls in flight that run dbt, whatever folder they work in: when each started, by tool-use id. */
const started = new Map<string, { at: number; cwd: string; writes: boolean }>()
/** The dbt calls that just ended: a run is recorded only when no other dbt call overlapped it. */
const finished: Array<{ at: number; ended: number }> = []
/** A call in flight longer than this is taken as one that never ended (refused or cancelled), so it stops holding back later calls. */
const IN_FLIGHT_MS = 60 * 60 * 1000
/** What Claude is told when a run was left out because dbt commands overlapped. */
export const OVERLAP_LINE = 'run not recorded: overlapping dbt commands'
/** Whether the command runs dbt at all, with any subcommand. */
export const runsDbt = (command: string) => parseDbtCommand(command).length > 0
/** Whether the command runs a dbt subcommand that writes run_results.json, whatever folder or project it names. */
export const writesResults = (command: string) => parseDbtCommand(command).some(one => one.subcommand !== null && WRITES_RESULTS.has(one.subcommand))
/** The artifact folder a call writes to, as one string: the project's own `target` and an unnamed one are the same folder. */
const folderOf = (one: Invocation) => {
  const named = one.targetPath === null ? null : normalize(one.targetPath.startsWith('/') ? one.targetPath : `${one.projectDir}/${one.targetPath}`)
  return named === null || named === normalize(`${one.projectDir}/target`) ? one.projectDir : named
}
const startKey = (e: BashCall) => e.tool_use_id

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

/**
 * Reads the last run of one project (and target folder) and keeps it when this call wrote it, else null.
 * `invocations` are the call's own for that folder: the file on disk is the last one's.
 */
async function readRun($: EngineInterface, invocations: Invocation[], all: Invocation[], began: number, ended: number): Promise<{ run: RunRecord; order: number } | null> {
  const last = invocations[invocations.length - 1]!
  const args = { project_dir: last.projectDir, ...(last.targetPath ? { target_path: last.targetPath } : {}) }
  // The CLI's answer carries the rows: the plugin's MCP server offers only a fixed set of tools.
  const result = await runTool($, 'dbt_run_results', args, { until: ended + READ_MS, cliOnly: true })
  const view = result.ok ? readable(result.metadata) : null
  if (!view || view.found === false || !view.completedAt) return null
  // A file older than the call is one this call did not write (dbt stopped before it ran anything);
  // one newer than the call is another command's, which would be recorded with this call's command line.
  const wrote = Date.parse(view.completedAt)
  if (wrote < began - CLOCK_SLACK_MS || wrote > ended + CLOCK_SLACK_MS) return null
  const written = writer(invocations, view.command)
  const run = written ? toRecord(view, written) : null
  return run && written ? { run, order: all.lastIndexOf(written) } : null
}

/** Reads each project's last run that this call wrote and records them; Claude gets one line each, or null. */
async function record($: EngineInterface, e: BashCall): Promise<string | null> {
  const ended = await $.clock.now()
  // The bookkeeping below is one block with no await in it: two calls ending together each see the other.
  const began = started.get(startKey(e))
  started.delete(startKey(e))
  if (began === undefined) return null
  // Any other dbt call that ran at the same time, in any folder, may have written the file this call would read: whose
  // artifact it is cannot be told, so nothing is recorded and Claude is told so. Never a guess.
  const live = [...started.values()].filter(other => other.at > ended - IN_FLIGHT_MS && other.at <= ended)
  const overlapped =
    // One that ran longer than the limit is itself taken as never ended, so what ran meanwhile is no longer known.
    ended - began.at > IN_FLIGHT_MS ||
    live.length > 0 ||
    finished.some(other => other.ended > began.at && other.at < ended)
  finished.push({ at: began.at, ended })
  // Kept back to the oldest call still running, never past the limit.
  const cutoff = Math.max(ended - IN_FLIGHT_MS, Math.min(ended, ...live.map(other => other.at)))
  while (finished.length > 500 || (finished[0] && finished[0].ended < cutoff)) finished.shift()
  if (!began.writes) return null
  if (overlapped) return OVERLAP_LINE
  const root = await $.session.root()
  const invocations = resultsInvocations(e.command, root, began.cwd)
  const mine = [...new Set(invocations.map(folderOf))]
  const free = mine
  // One read for each folder, at the same time: a slow one does not take the others' time, a failed one does not stop them.
  const read = await Promise.all(
    free.map(folder => readRun($, invocations.filter(one => folderOf(one) === folder), invocations, began.at, ended).catch(() => null)),
  )
  // Two spellings of one folder read one file: of its runs the later invocation's is the one that wrote it.
  const latest = new Map<string, { run: RunRecord; order: number }>()
  for (const one of read) {
    if (one && (latest.get(one.run.id)?.order ?? -1) < one.order) latest.set(one.run.id, one)
  }
  // Oldest first, so the history stays newest first.
  const runs = [...latest.values()].map(one => one.run).sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
  if (runs.length === 0) return null
  const lines = await serially(async () => {
    const all = await held($)
    let kept = all[root] ?? []
    const noted: string[] = []
    for (const run of runs) {
      // The same file as the last recording: nothing new was written.
      if (kept.find(one => one.project === run.project)?.id === run.id) continue
      kept = withRun(kept, run)
      noted.push(summaryLine(run))
    }
    if (noted.length === 0) return noted
    const next = fitStore({ ...all, [root]: kept })
    await $.store.set(STORE_KEY, next)
    await update($, runsAtom, prev => (prev?.root === root ? { ...prev, runs: next[root] ?? [] } : prev))
    return noted
  })
  return lines.length > 0 ? lines.join('\n') : null
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
          <Box key={`row-${rows.indexOf(row)}-${row.uniqueId}`} flexDirection="column">
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
  // Every dbt call counts for the overlap rule, one that writes no results too: it is told apart only by `writes`.
  if (!runsDbt(e.command)) return null
  const cwd = await $.session.cwd()
  started.set(startKey(e), { at: await $.clock.now(), cwd, writes: writesResults(e.command) })
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
