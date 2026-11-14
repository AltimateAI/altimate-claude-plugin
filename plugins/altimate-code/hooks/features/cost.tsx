// Cost check: BigQuery scans over the limit are held until allowed.
//
// Before a `dbt run`, `dbt build` or `dbt show` Claude runs, the gate asks altimate-code's
// dbt_cost_estimate (a BigQuery dry run) what the query would scan. Over `maxScanBytes` the command is
// refused with the estimate until the user runs /allow-scan, which lets that same command through once.
// Other warehouses have no dry run: the first answer says so, and nothing is estimated or held after that.
// Only what names its query is estimated: `dbt show --inline <sql>` and a single plain model name
// (`-s orders`); any other selection, and any command that sets its own target, defer state, vars or
// project, runs as it is, with one line saying so under the Bash row.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, RenderElement, ToolCallResult } from 'claude-code'

import { runTool } from '../altimate-cli'
import { parseDbtCommand, type DbtInvocation } from '../dbt-command'
import { setStatusPart } from '../status-line'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { CostState } from '../../types'
import type { BandUi, FeatureContext } from './index'

/** Used when `maxScanBytes` is missing from the plugin's options: 10 GiB, as plugin.json's default. */
const DEFAULT_MAX_SCAN_BYTES = 10 * 1024 ** 3
/** The adapter may have to start (dbt deps, a parse) for the first estimate. */
const ESTIMATE_BUDGET_MS = 120_000
/** The dbt subcommands that run SQL a person pays for. */
const SCANNING = new Set(['run', 'build', 'show'])
/** A selector that is one plain model name: no graph operator, tag, path, package or wildcard. */
const PLAIN_MODEL = /^[A-Za-z_][A-Za-z0-9_]*$/
/** What the CLI answers for a tool it doesn't have (altimate-code's tool-cli runner). */
const UNKNOWN_TOOL = /Unknown tool/i
/** The altimate-code that has dbt_cost_estimate; changing it is the one edit a release needs. */
const NEEDED_VERSION = 'a newer altimate-code (the release with dbt_cost_estimate)'

const costAtom = atom({ plugin: 'altimate-code', key: 'cost' } as const, null as CostState | null)

const FRESH: CostState = { unsupportedAdapter: null, lastEstimate: null, held: null, allowOnce: false }

/** The limit in force; set by `register` from the plugin's options. 0 never holds. */
let limitBytes = DEFAULT_MAX_SCAN_BYTES
/** The lines to show under an estimated command's Bash row, by command; each gate pass replaces the last. Taken by bashAfter. */
const notes = new Map<string, string[]>()

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  const configured = Number((context.options as Record<string, unknown> | undefined)?.maxScanBytes)
  limitBytes = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MAX_SCAN_BYTES

  on('command.run', { command: 'allow-scan' }, async $ => {
    // The allowance is set against the hold it was read from, in the same step: a hold replaced meanwhile is not allowed.
    const held = (await read($, costAtom))?.held
    let allowed = false
    await update($, costAtom, prev => {
      const current = prev ?? FRESH
      allowed = !!held && current.held?.command === held.command
      return allowed ? { ...current, allowOnce: true } : current
    })
    if (!held) return { text: 'Nothing is held: no dbt command is waiting on its scan size.' }
    if (!allowed) return { text: 'The held command changed meanwhile: run /allow-scan again to allow the one now held.' }
    return { text: `Allowed: ${held.target} (≈ ${held.display}) runs once when Claude runs the same command again; after that it is held again.` }
  })

  on('command.run', { command: 'scan-cost' }, async ($, e) => {
    const target = e.args.trim()
    if (!target) {
      const last = (await read($, costAtom))?.lastEstimate
      return { text: last ? `Last estimate: ${last.target} would scan ${last.display}. Run /scan-cost <model> for another.` : 'Run /scan-cost <model> to estimate the scan of a model.' }
    }
    const answer = await estimate($, { model: target }, (await $.clock.now()) + ESTIMATE_BUDGET_MS)
    if (answer.kind === 'bytes') {
      await rememberEstimate($, target, answer.bytes, answer.display)
      return { text: `${target} would scan ${answer.display}${verdict(answer.maxBytes)}` }
    }
    return { text: answer.kind === 'unsupported' ? `No estimate: ${answer.adapter} has no dry run (only BigQuery has).` : `No estimate: ${answer.reason}` }
  })
}

/** After the session started: the place to register commands. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  notes.clear()
  await update($, costAtom, () => ({ ...FRESH }))
  await setStatusPart($, 'cost', null)
  await $.command.register({ name: 'allow-scan', description: 'Let the dbt command held for its BigQuery scan size run once, when run again unchanged' })
  await $.command.register({ name: 'scan-cost', description: 'Estimate the BigQuery scan of a dbt model before running it', argumentHint: '<model>' })
}

/** Also called for a subagent's turns, which carry `e.agentId`. */
export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

/** After the turn's answer; `out` is what the turn ended with. Also called for a subagent's turns (`e.agentId`). */
export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {}

export async function sessionEnd($: EngineInterface, e: Args<'session.end'>) {}

/** This feature's line in the band: the command held, until it is allowed or a later dbt command is not held. */
export async function bandLine($: EngineInterface, ui: BandUi): Promise<RenderElement | null> {
  const held = (await read($, costAtom))?.held
  if (!held) return null
  return <ui.Text color="warning">{`⛔ held: ${held.target} would scan ${held.display} (limit ${formatBytes(limitBytes)}) · /allow-scan`}</ui.Text>
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
  if (limitBytes <= 0) return null
  const all = parseDbtCommand(e.command)
  const invocations = all.filter(i => i.subcommand !== null && SCANNING.has(i.subcommand))
  if (invocations.length === 0) return null
  const state = (await read($, costAtom)) ?? FRESH
  // A warehouse with no dry run was found out already: the command is never held, and nothing is asked again.
  if (state.unsupportedAdapter) return null

  const lines: string[] = []
  let estimated = false
  const over: { label: string; bytes: number; display: string }[] = []
  // One budget for the whole command, however many queries it names.
  const until = (await $.clock.now()) + ESTIMATE_BUDGET_MS
  for (const invocation of invocations) {
    const target = targetOf(e.command, invocation, all)
    if (!target.model && target.sql === undefined) {
      lines.push(`cost · no estimate for this selection (${target.why})`)
      continue
    }
    const label = target.model ?? 'the inline query'
    const answer = await estimate($, target.model ? { model: target.model } : { sql: target.sql }, until)
    if (answer.kind === 'unsupported') {
      await update($, costAtom, prev => ({ ...(prev ?? FRESH), unsupportedAdapter: answer.adapter }))
      lines.push(`cost · no estimate on ${answer.adapter}: only BigQuery has a dry run`)
      break
    }
    if (answer.kind === 'none') {
      lines.push(`cost · no estimate for ${label}: ${answer.reason}`)
      continue
    }
    estimated = true
    await update($, costAtom, prev => ({ ...(prev ?? FRESH), lastEstimate: { target: label, bytes: answer.bytes, display: answer.display } }))
    await setStatusPart($, 'cost', `scan ≈ ${answer.display}`)
    if (answer.maxBytes <= limitBytes) lines.push(`cost · ${label} would scan ${answer.display}`)
    else over.push({ label, bytes: answer.maxBytes, display: answer.display })
  }

  if (over.length > 0) {
    const worst = over.reduce((a, b) => (b.bytes > a.bytes ? b : a))
    // The allowance is spent in one step, and only by the command that was held for it.
    let granted = false
    await update($, costAtom, prev => {
      const current = prev ?? FRESH
      granted = current.allowOnce && current.held?.command === e.command
      return granted
        ? { ...current, allowOnce: false, held: null }
        : { ...current, allowOnce: false, held: { command: e.command, target: worst.label, bytes: worst.bytes, display: worst.display } }
    })
    if (granted) {
      for (const one of over) lines.push(`cost · ${one.label} would scan ${one.display}, over the ${formatBytes(limitBytes)} limit: allowed once`)
      keepNotes(e.command, lines)
      return null
    }
    notes.delete(e.command)
    await setStatusPart($, 'cost', `scan held ≈ ${worst.display}`)
    return {
      deny: `≈ ${worst.display} would be scanned, over the ${formatBytes(limitBytes)} limit. Narrow the query, or ask the user to run /allow-scan and then run the same command again.`,
    }
  }
  // A command that was estimated and is under the limit ends an earlier hold, and its allowance. One that
  // was not estimated says nothing, so the hold stays.
  if (estimated && (state.held || state.allowOnce)) {
    await update($, costAtom, prev => (prev?.held || prev?.allowOnce ? { ...prev, held: null, allowOnce: false } : prev))
    const last = (await read($, costAtom))?.lastEstimate
    await setStatusPart($, 'cost', last ? `scan ≈ ${last.display}` : null)
  }
  keepNotes(e.command, lines)
  return null
}

function keepNotes(command: string, lines: string[]) {
  if (lines.length > 0) notes.set(command, lines)
  else notes.delete(command)
}

/** What the gate said about the command, under its Bash row. */
export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {
  const lines = notes.get(e.command)
  notes.delete(e.command)
  return lines
}

/** `file.before` holds the text from before the edit only when `editReadsBefore` is true. */
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false

type Target = { model?: string; sql?: string; why: string }

/** More dbt calls than this on one line are not estimated. */
const MAX_INVOCATIONS = 20
/** The dbt launchers whose project is the session's: nothing else on the line can move it. */
const PLAIN_LAUNCHER = /^((uv|poetry) run )?(\S*\/)?dbt$/
/** Flags with one value that leave the project, target and compiled SQL as they are. */
const VALUE_FLAGS = new Set(['--inline', '--limit', '--threads'])
/** Flags that name the models; any number of values follow. */
const SELECT_FLAGS = new Set(['-s', '--select', '-m', '--models', '--model'])
/** Flags without a value that leave the project, target and compiled SQL as they are. */
const PLAIN_FLAGS = new Set(['--fail-fast', '-x', '--quiet', '-q'])

/**
 * Whether the estimate would be of what the invocation runs. It asks about the session's project at its
 * default target, so it is only so when the line moves neither: the dbt launcher is plain, nothing
 * precedes the invocation but other dbt invocations, and every flag is one known to leave the query
 * alone, with no expansion on the line. Anything else (another target, defer state, vars, project, a
 * full refresh) is not estimated.
 */
function isPlainInvocation(command: string, invocation: DbtInvocation, all: DbtInvocation[]): boolean {
  // The shell expands `$` and backticks anywhere on the line (arguments, redirections, an earlier call) into
  // flags or environment this check can't see; a line with many calls is not worth reading call by call.
  if (/[$`]/.test(command) || all.length > MAX_INVOCATIONS) return false
  if (!PLAIN_LAUNCHER.test(invocation.binary)) return false
  let before = command.slice(0, invocation.start)
  for (const earlier of all.filter(one => one.end <= invocation.start).reverse()) {
    before = before.slice(0, earlier.start) + ' ' + before.slice(earlier.end)
  }
  if (!/^[\s;&]*$/.test(before)) return false
  const words = shellWords(command.slice(invocation.start, invocation.end))
  const launcher = shellWords(invocation.binary)
  if (launcher.some((word, i) => words[i] !== word) || words[launcher.length] !== invocation.subcommand) return false
  let selecting = false
  let pending = false
  for (const word of words.slice(launcher.length + 1)) {
    if (pending) {
      pending = false
      continue
    }
    const flag = word.startsWith('-') ? word.split('=')[0]! : null
    if (flag === null) {
      if (selecting) continue
      return false
    }
    selecting = SELECT_FLAGS.has(flag)
    if (selecting || PLAIN_FLAGS.has(flag)) continue
    if (VALUE_FLAGS.has(flag)) pending = !word.includes('=')
    else return false
  }
  return true
}

/** What a scanning invocation names to estimate: its inline SQL, or one plain model; else why not. */
function targetOf(command: string, invocation: DbtInvocation, all: DbtInvocation[]): Target {
  const text = command.slice(invocation.start, invocation.end)
  if (!isPlainInvocation(command, invocation, all)) {
    return { why: 'it sets its own target, defer state, vars, project or refresh mode, or runs after something that might' }
  }
  if (invocation.subcommand === 'show') {
    const inline = inlineSql(text)
    if (inline !== null) return inline.trim() ? { sql: inline, why: '' } : { why: 'empty inline query' }
  }
  const [only, ...rest] = invocation.select
  if (only === undefined) return { why: 'no model named; selection resolves with dbt ls' }
  if (rest.length > 0) return { why: 'several selectors' }
  if (!PLAIN_MODEL.test(only)) return { why: `${only} is a graph, tag, path or package selector` }
  return { model: only, why: '' }
}

/** The SQL of `--inline` in a dbt command's text, unquoted as the shell would; null when there is none. */
export function inlineSql(text: string): string | null {
  const words = shellWords(text)
  // dbt keeps the last of a repeated option.
  let found: string | null = null
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === '--inline') found = words[i + 1] ?? null
    else if (word.startsWith('--inline=')) found = word.slice('--inline='.length)
  }
  return found
}

/** The words of a command's text with their quotes and backslashes resolved. */
function shellWords(text: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    // A backslash before a line break joins the lines, in a word or in double quotes.
    if (c === '\\' && quote !== "'" && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      i += text[i + 1] === '\n' ? 1 : 2
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) word += text[++i]
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i]
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (inWord) words.push(word)
  return words
}

type Answer = { kind: 'bytes'; bytes: number; maxBytes: number; display: string } | { kind: 'unsupported'; adapter: string } | { kind: 'none'; reason: string }

/** Asks altimate-code for the scan of a model or SQL; never throws: a failure is `none` with why. */
async function estimate($: EngineInterface, args: { model?: string; sql?: string }, until: number): Promise<Answer> {
  try {
    const run = await runTool($, 'dbt_cost_estimate', args, { write: true, until })
    if (!run.ok && UNKNOWN_TOOL.test(run.text)) return { kind: 'none', reason: `this altimate-code has no cost estimate: it needs ${NEEDED_VERSION}` }
    const data = run.metadata as { supported?: unknown; adapter?: unknown; bytes?: unknown; maxBytes?: unknown; display?: unknown; error?: unknown } | null
    if (data?.supported === false) return { kind: 'unsupported', adapter: typeof data.adapter === 'string' ? data.adapter : 'this warehouse' }
    if (data?.supported === true && typeof data.bytes === 'number' && Number.isFinite(data.bytes)) {
      // The tool's upper bound when it gives one: the display is rounded, and the limit is a hard one.
      const maxBytes = typeof data.maxBytes === 'number' && Number.isFinite(data.maxBytes) && data.maxBytes >= data.bytes ? data.maxBytes : data.bytes
      return { kind: 'bytes', bytes: data.bytes, maxBytes, display: typeof data.display === 'string' ? data.display : formatBytes(data.bytes) }
    }
    const why = typeof data?.error === 'string' ? data.error : run.text.trim().split('\n')[0] || 'altimate-code gave no estimate'
    return { kind: 'none', reason: why }
  } catch (error) {
    return { kind: 'none', reason: error instanceof Error ? error.message : String(error) }
  }
}

async function rememberEstimate($: EngineInterface, target: string, bytes: number, display: string) {
  await update($, costAtom, prev => ({ ...(prev ?? FRESH), lastEstimate: { target, bytes, display } }))
  await setStatusPart($, 'cost', `scan ≈ ${display}`)
}

/** What an estimate means against the limit, as a sentence tail for /scan-cost. */
function verdict(maxBytes: number): string {
  if (limitBytes <= 0) return '.'
  return maxBytes > limitBytes ? `, over the ${formatBytes(limitBytes)} limit: a dbt run of it is held until /allow-scan.` : `, within the ${formatBytes(limitBytes)} limit.`
}

/** Bytes in the units BigQuery's dry run writes them in: "4.2 TiB". */
export function formatBytes(bytes: number): string {
  const units = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let n = bytes
  let i = 0
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}
