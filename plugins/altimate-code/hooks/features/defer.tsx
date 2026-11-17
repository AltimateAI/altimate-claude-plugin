// Defer and target: --defer --state on dbt commands, and the target in the status line.
//
// The plugin calls each function below at its moment, in the order features/index.ts fixes; one with
// nothing to do stays a no-op. This feature's own hooks (its commands and panes, each under a matcher
// no other part uses) go in `register`. The events the whole plugin shares (session start and end,
// turns, Bash and file tool calls, the band) come through the other functions, since a plugin hooks
// each of those once. The status-line part is set with `setStatusPart($, 'defer', text)`.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, RenderElement, ToolCallResult } from 'claude-code'

import { runTool } from '../altimate-cli'
import { parseDbtCommand } from '../dbt-command'
import { setStatusPart } from '../status-line'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { DeferState } from '../../types'
import type { BandUi, FeatureContext } from './index'

const deferAtom = atom({ plugin: 'altimate-code', key: 'defer' } as const, null as DeferState | null)

// The commands that take `--defer` in every dbt version this reads state for (older dbt refuses the option on
// `ls`, `parse`, `seed`, `run-operation` and others, and `retry` reads the previous run's results from `--state`).
const DEFERS = new Set(['build', 'run', 'test', 'compile', 'show', 'snapshot'])
// Commands that take no target, or take it after a second word (`source freshness`, `docs generate`) this does not read.
const NO_TARGET = new Set(['deps', 'clean', 'init', 'retry', 'docs', 'source'])

const quote = (text: string) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`)

export type RewriteOptions = {
  /** The directory to defer to; null or undefined means defer is off. */
  stateDir?: string | null
  favorState?: boolean
  /** The session's target, chosen with /target; added to a command without one, even when it is the profile's default, since the environment may say another. */
  target?: string | null
  defaultTarget?: string | null
}

/**
 * The shell command with `--defer --state <dir>` (and `--favor-state`) and `--target <name>` inserted
 * right after the subcommand of each dbt invocation that does not already set them; the command itself
 * when nothing needs to change. An invocation with a word the parser cannot read (`$FLAGS`, `~/x`, a glob) is left as written.
 */
export function rewriteDeferCommand(command: string, options: RewriteOptions): string {
  const { stateDir, favorState = false, target } = options
  if (!stateDir && !target) return command
  let out = command
  // DBT_STATE or DBT_TARGET exported in the line is the user's own choice: none of its dbt commands gets the flag
  // (a line with an `export` and the variable anywhere in it counts, whatever the quoting).
  const exportedState = /\bexport\b/.test(command) && /\bDBT_(?:STATE|DEFER|DEFER_STATE|FAVOR_STATE)=/.test(command)
  const exportedTarget = /\bexport\b/.test(command) && /\bDBT_TARGET=/.test(command)
  // From the last invocation to the first, so the offsets of those before stay right.
  for (const one of [...parseDbtCommand(command)].sort((a, b) => b.subcommandEnd - a.subcommandEnd)) {
    if (!one.subcommand) continue
    // The parser cannot say what the shell passes to dbt for a word that holds an expansion, a glob or a `~`, and a flag
    // may be among them: such an invocation is left as the user wrote it, as the parser's contract asks.
    if (one.dynamic) continue
    const flags: string[] = []
    if (stateDir && !exportedState && DEFERS.has(one.subcommand) && !one.hasDefer && !one.hasState && !/\bDBT_(?:DEFER|DEFER_STATE|FAVOR_STATE)=/.test(command.slice(one.start, one.end))) flags.push('--defer', '--state', quote(stateDir), ...(favorState && !/--(?:no-)?favor-state\b/.test(command.slice(one.start, one.end)) ? ['--favor-state'] : []))
    if (target && !NO_TARGET.has(one.subcommand) && one.target === null && !exportedTarget && !/\bDBT_TARGET=/.test(command.slice(one.start, one.end))) flags.push('--target', quote(target))
    if (flags.length === 0) continue
    out = `${out.slice(0, one.subcommandEnd)} ${flags.join(' ')}${out.slice(one.subcommandEnd)}`
  }
  return out
}

type DeferAnswer = {
  success?: boolean
  enabled?: boolean
  favorState?: boolean
  mode?: 'local' | 'remote' | 'none'
  stateDir?: string
  reason?: string
  defaultTarget?: string
  targets?: string[]
}

const dirname = (path: string) => path.replace(/[\\/]+[^\\/]*$/, '') || '/'

/** The dbt project the session works in: the folder or one above it with a dbt_project.yml, else the only one a level below. */
async function findProject($: EngineInterface): Promise<string | null> {
  // A call that throws at once (an engine without a session) is no project either.
  const root = await Promise.resolve().then(() => $.session.root()).catch(() => null)
  if (!root) return null
  for (let dir = root, i = 0; i < 40; i++) {
    if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const below: string[] = []
  for (const entry of await $.fs.list(root).catch(() => [])) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (await $.fs.exists(`${root}/${entry.name}/dbt_project.yml`).catch(() => false)) below.push(`${root}/${entry.name}`)
  }
  return below.length === 1 ? below[0]! : null
}

/**
 * Whether the command's dbt runs in the project: `runsInProject`, with the folders it asks about checked
 * for a dbt_project.yml of their own. A folder below the project that holds one has its own settings, at any
 * depth and through a link; no folder tree is scanned.
 */
export async function runsHere($: EngineInterface, command: string, root: string, projectDir: string): Promise<boolean> {
  const asked = new Set<string>()
  // A first pass with no nested project: a nested one only narrows the answer, so a no here is final.
  if (!runsInProject(command, root, projectDir, dir => (asked.add(dir), false))) return false
  if (asked.size === 0) return true
  const owned = new Set<string>()
  for (const dir of asked) if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) owned.add(dir)
  return runsInProject(command, root, projectDir, dir => owned.has(dir))
}

// Where a command runs from: the session folder, moved by each `cd` or `pushd` in the command.
const CD = /(?:^|[;&|(\n{!]\s*|\b(?:if|elif|while|until|then|do|else|time)\s+)(?:cd|pushd)[ \t]+("[^"]+"|'[^']+'|[^\s;&|)]+)/gm
const PROJECT_DIR = /(?:--project-dir[\s=]|\bDBT_PROJECT_DIR=)("[^"]+"|'[^']+'|[^\s;&|)]+)/g
const UNQUOTE = /^['"]|['"]$/g

/** `target` seen from `base`, as an absolute path with forward slashes (a drive letter kept); null when it cannot be known. */
function resolvePath(base: string, target: string): string | null {
  if (/^~|[$`]/.test(target)) return null
  const from = base.replace(/\\/g, '/')
  const to = target.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(to)?.[0] ?? /^[A-Za-z]:/.exec(from)?.[0] ?? ''
  const path = /^[A-Za-z]:\//.test(to) ? to.slice(2) : to.startsWith('/') ? to : `${from.slice(drive.length)}/${to}`
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${drive}/${out.join('/')}`
}

/**
 * Whether the command's dbt runs in the project the settings were read for: not when it moves to another
 * folder (`cd`, `pushd`, `--project-dir`, `DBT_PROJECT_DIR`, uv's `--directory`) or one it cannot work out.
 */
export function runsInProject(command: string, root: string, projectDir: string, isProject: (dir: string) => boolean = () => false): boolean {
  // A folder change this does not follow (`popd`, `env -C`, `command cd`, a `cd` with no folder) leaves the folder unknown.
  // Quotes and backslashes are dropped for this check: `command 'cd' ../b` and `env "-C" ../b` change folder like their plain forms.
  const plain = command.replace(/["'\\]/g, '')
  if (/\s--(?:directory|project)[\s=]/.test(plain)) return false
  if (/(?:^|[\s;&|(){}!])(?:popd|chdir)(?=[\s;&|)]|$)|\benv\s+(?:\S+\s+)*(?:-C|--chdir)\b/.test(plain)) return false
  const cdWords = plain.match(/(?:^|[\s;&|(){}!`])(?:cd|pushd)(?=[\s;&|)]|$)/g)?.length ?? 0
  if (cdWords !== [...command.matchAll(CD)].length) return false
  // A folder change inside a subshell or command substitution leaves the parent's folder unchanged or unknown.
  if (cdWords > 0 && /[(`]/.test(plain)) return false
  const invocations = parseDbtCommand(command)
  // The outermost command that starts first, not an invocation inside a `<(...)` that ends up first in the list.
  const first = [...invocations].sort((a, b) => a.start - b.start)[0]
  const project = resolvePath(projectDir, '.')
  if (!first || !project) return false
  const base = project.replace(/\/+$/, '')
  // A folder below the project that holds a dbt project of its own has its own settings.
  const ownsProject = (dir: string) => {
    for (let d = dir; d.startsWith(`${base}/`); d = dirname(d)) if (isProject(d)) return true
    return false
  }
  const inside = (dir: string | null) => !!dir && (dir === project || (dir.startsWith(`${base}/`) && !ownsProject(dir)))
  const windows = /^[A-Za-z]:/.test(projectDir)
  let dir = resolvePath(root, '.')
  let before = dir
  for (const match of command.matchAll(CD)) {
    if (!dir) return false
    // A folder word with an escape (`nested\ project`) is cut short by the pattern: not a folder this can work out.
    if (/\\/.test(match[1]!) && !(windows && /^['"]/.test(match[1]!))) return false
    // A `cd` that may not run (after `||`, after another command in an `&&` list, inside `if`, `then` or a loop) leaves the folder unknown.
    const at = match.index + match[0].search(/(?:cd|pushd)[ \t]+/)
    const lead = command.slice(0, at)
    if (!/^\s*(?:(?:cd|pushd)[ \t]+\S+\s*&&\s*)*$/.test(lead.slice(Math.max(lead.lastIndexOf(';'), lead.lastIndexOf('\n')) + 1))) return false
    // A folder word that goes on after its quotes (`"."/..`) is not one this can work out.
    if (!/^(?:[\s;&|)]|$)/.test(command.slice(match.index + match[0].length))) return false
    const word = match[1]!.replace(UNQUOTE, '')
    // `cd -P dir`, `cd -`: not a folder this can work out.
    dir = word.startsWith('-') ? null : resolvePath(dir, word)
    if (match.index < first.start) before = dir
    else if (!inside(dir)) return false
  }
  // A project named outright is the one to judge; otherwise the folder the command runs from.
  const named = [...command.matchAll(PROJECT_DIR)]
  // A project option written with quotes (`"--project-dir" ../b`) is only seen in the plain copy: unknown.
  if (named.length !== (plain.match(/--project-dir[\s=]|\bDBT_PROJECT_DIR=/g)?.length ?? 0)) return false
  // A path word that goes on after its quotes (`--project-dir "."/../b`) is not one this can work out.
  // An escaped word (`./a\ b`) is cut short by this pattern at the escaped space: not a path this can work out.
  // On a Windows project path a backslash separates folders; elsewhere any backslash may be an escape.
  // In an unquoted word the shell eats a backslash as an escape, so only a quoted word keeps it as a separator.
  if (named.some(match => (windows && /^['"]/.test(match[1]!) ? /\\$/.test(match[1]!) : match[1]!.includes('\\')))) return false
  if (named.some(match => !/^(?:[\s;&|)]|$)/.test(command.slice(match.index + match[0].length)))) return false
  if (named.length === 0) return inside(before)
  // Only a single dbt invocation, with the project named inside it, is judged: elsewhere in the line it is another command's.
  if (invocations.length !== 1 || !before) return false
  if (named.some(match => match.index < first.start || match.index >= first.end)) return false
  // Exactly the project: a folder below it may be a separate dbt project with its own settings.
  return named.every(match => resolvePath(before!, match[1]!.replace(UNQUOTE, '')) === project)
}

/** The flags the state's override and answer lead to: the state dir only while defer is on. */
export function effective(state: DeferState | null): RewriteOptions {
  if (!state) return {}
  const on = state.override ?? state.enabled
  return {
    stateDir: on ? state.stateDir : null,
    favorState: state.favorState,
    target: state.target,
    defaultTarget: state.defaultTarget,
  }
}

/** The status line's part: "dbt dev · defer prod" (target, then defer). */
export function statusText(state: DeferState | null): string | null {
  if (!state?.projectDir) return null
  const target = state.target ?? state.defaultTarget
  const on = state.override ?? state.enabled
  const parts: string[] = []
  if (target) parts.push(`dbt ${target}`)
  if (on && state.stateDir) parts.push(`defer ${state.stateDir.split(/[\\/]/).filter(Boolean).pop() ?? 'on'}`)
  return parts.length ? parts.join(' · ') : null
}

async function load($: EngineInterface, previous: DeferState | null): Promise<DeferState> {
  const projectDir = await findProject($)
  const state: DeferState = {
    projectDir,
    enabled: false,
    favorState: false,
    mode: 'none',
    stateDir: null,
    reason: null,
    override: previous?.override ?? null,
    defaultTarget: null,
    targets: [],
    target: previous?.target ?? null,
    failedAt: null,
  }
  if (!projectDir) return state
  const answer = await runTool($, 'dbt_defer_state', { project_dir: projectDir }, { cliOnly: true }).catch(() => null)
  const data = answer?.ok && (answer.metadata as DeferAnswer | null)?.success !== false ? (answer.metadata as DeferAnswer | null) : null
  if (!data) return { ...state, reason: answer?.text || 'altimate-code did not answer', failedAt: await $.clock.now() }
  return {
    ...state,
    enabled: data.enabled === true && typeof data.stateDir === 'string',
    favorState: data.favorState === true,
    mode: data.mode ?? 'none',
    stateDir: data.stateDir ?? null,
    reason: data.reason ?? null,
    defaultTarget: data.defaultTarget ?? null,
    targets: data.targets ?? [],
  }
}

// The read in flight, shared by whoever needs the answer first.
let loading: Promise<DeferState> | null = null
// Counts the sessions: an answer read for an earlier one is dropped.
let generation = 0
// A read that failed (the CLI timed out or was not ready) is tried again after this long.
const RETRY_MS = 60_000

/** The state the project's setting gives, read on first need and kept for the session (a failed read is tried again after a minute); /defer reset reads it again. */
async function ensure($: EngineInterface): Promise<DeferState> {
  const have = await read($, deferAtom)
  if (have && (have.failedAt === null || (await $.clock.now()) - have.failedAt < RETRY_MS)) return have
  const mine = generation
  const started = (loading ??= load($, have).then(async state => {
    if (mine === generation) await publish($, state)
    return state
  }))
  let state: DeferState
  try {
    state = await started
  } finally {
    // Another session's read must not be dropped by a caller that was waiting on this one; a read that rejected is not kept.
    if (loading === started) loading = null
  }
  return mine === generation ? state : await ensure($)
}

async function publish($: EngineInterface, state: DeferState) {
  await update($, deferAtom, () => state)
  await setStatusPart($, 'defer', statusText(state)).catch(() => {})
}

function describe(state: DeferState | null): string {
  if (!state?.projectDir) return 'defer: no dbt project found in this folder.'
  const on = state.override ?? state.enabled
  const lines = [
    `defer: ${on && state.stateDir ? 'on' : 'off'}${state.override !== null ? ` (set with /defer ${state.override ? 'on' : 'off'} for this session)` : ''}`,
    `project: ${state.projectDir}`,
    `mode: ${state.mode}`,
  ]
  if (state.stateDir) lines.push(`state: ${state.stateDir}${state.favorState ? ' (favor state)' : ''}`)
  if (state.reason) lines.push(`note: ${state.reason}`)
  lines.push(`target: ${state.target ?? state.defaultTarget ?? 'profile default'}${state.target ? ' (session)' : ''}`)
  if (state.targets.length) lines.push(`targets: ${state.targets.join(', ')}`)
  return lines.join('\n')
}

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  on('command.run', { command: 'defer' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const started = generation
    let state = await ensure($)
    if (word === 'on' || word === 'off') {
      if (word === 'on' && !state.stateDir) {
        await publish($, state)
        return { text: `Defer cannot be turned on: ${state.reason ?? 'no state directory is configured for this project (dbt.deferConfigPerProject).'}` }
      }
      state = { ...state, override: word === 'on' }
      // A session that started while the setting was read has its own state.
      if (started === generation) await publish($, state)
      return { text: `Defer ${word} for this session.\n${describe(state)}` }
    }
    if (word === 'reset') {
      const mine = generation
      state = await load($, null)
      // A session that started while this read ran has its own state.
      if (mine === generation) await publish($, state)
      return { text: `Defer and target back to the project's settings.\n${describe(state)}` }
    }
    if (word === '' || word === 'status') {
      return { text: describe(state) }
    }
    return { text: 'Usage: /defer [status|on|off|reset]' }
  })

  on('command.run', { command: 'target' }, async ($, e) => {
    const name = e.args.trim()
    const started = generation
    let state = await ensure($)
    if (name === '') {
      return { text: `target: ${state.target ?? state.defaultTarget ?? 'profile default'}${state.target ? ' (session)' : ''}${state.targets.length ? `\ntargets: ${state.targets.join(', ')}` : ''}` }
    }
    if (name === 'reset') {
      state = { ...state, target: null }
      await publish($, state)
      return { text: `Target back to the profile default${state.defaultTarget ? ` (${state.defaultTarget})` : ''}.` }
    }
    if (!/^[\w.-]+$/.test(name)) return { text: `Not a target name: ${name}` }
    if (state.targets.length && !state.targets.includes(name)) {
      return { text: `No target "${name}" in the profile. Targets: ${state.targets.join(', ')}` }
    }
    if (!state.projectDir) return { text: 'No dbt project found in this folder, so there is no target to set.' }
    state = { ...state, target: name }
    if (started === generation) await publish($, state)
    return { text: `dbt commands now run with --target ${name} (this session).` }
  })
}

/** After the session started: registers the commands. The project's setting is read when first needed. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  await $.command.register({ name: 'defer', description: "Show or set whether dbt commands defer to the production manifest", argumentHint: '[status|on|off|reset]' })
  await $.command.register({ name: 'target', description: "Set the dbt target for this session's dbt commands", argumentHint: '[<name>|reset]' })
  // A new session starts from the project's own settings, not from the last one's overrides.
  generation++
  loading = null
  await update($, deferAtom, () => null)
  // Clearing the line is cosmetic: an engine that cannot draw it does not stop the session.
  await setStatusPart($, 'defer', null).catch(() => {})
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
  // Most commands name no dbt: they never cost the settings read.
  if (!/\bdbt\b/.test(e.command) || parseDbtCommand(e.command).length === 0) return null
  const state = await ensure($)
  if (!state.projectDir) return null
  // The folder the session's shell is in now: an earlier `cd` in the session moves it, which the project root does not.
  const root = (await $.session.cwd().catch(() => null)) ?? (await $.session.root().catch(() => null))
  if (!root) return null
  if (!(await runsHere($, e.command, root, state.projectDir))) return null
  const command = rewriteDeferCommand(e.command, effective(state))
  return command === e.command ? null : command
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
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
