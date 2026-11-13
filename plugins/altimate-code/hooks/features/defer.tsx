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

/** dbt commands that read no project graph: they get neither the defer flags nor a target. */
const NO_FLAGS = new Set(['deps', 'clean', 'debug', 'init', 'retry', 'docs', 'source'])

const quote = (text: string) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`)

export type RewriteOptions = {
  /** The directory to defer to; null or undefined means defer is off. */
  stateDir?: string | null
  favorState?: boolean
  /** The session's target; added to a command without one when it differs from the profile's default. */
  target?: string | null
  defaultTarget?: string | null
}

/**
 * The shell command with `--defer --state <dir>` (and `--favor-state`) and `--target <name>` inserted
 * right after the subcommand of each dbt invocation that does not already set them; the command itself
 * when nothing needs to change.
 */
export function rewriteDeferCommand(command: string, options: RewriteOptions): string {
  const { stateDir, favorState = false, target, defaultTarget } = options
  if (!stateDir && !target) return command
  let out = command
  // From the last invocation to the first, so the offsets of those before stay right.
  for (const one of parseDbtCommand(command).reverse()) {
    if (!one.subcommand || NO_FLAGS.has(one.subcommand)) continue
    const flags: string[] = []
    if (stateDir && !one.hasDefer && !one.hasState) flags.push('--defer', '--state', quote(stateDir), ...(favorState ? ['--favor-state'] : []))
    if (target && target !== defaultTarget && one.target === null) flags.push('--target', quote(target))
    if (flags.length === 0) continue
    out = `${out.slice(0, one.subcommandEnd)} ${flags.join(' ')}${out.slice(one.subcommandEnd)}`
  }
  return out
}

type DeferAnswer = {
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
  const root = await $.session.root().catch(() => null)
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
  }
  if (!projectDir) return state
  const answer = await runTool($, 'dbt_defer_state', { project_dir: projectDir }, { cliOnly: true }).catch(() => null)
  const data = answer?.ok ? (answer.metadata as DeferAnswer | null) : null
  if (!data) return { ...state, reason: answer?.text ?? 'altimate-code did not answer' }
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

// The first answer of the session, shared by whoever needs it first.
let loading: Promise<DeferState> | null = null

/** The state the project's setting gives, read once per session on first need; /defer reset reads it again. */
async function ensure($: EngineInterface): Promise<DeferState> {
  const have = await read($, deferAtom)
  if (have) return have
  loading ??= load($, null).then(async state => {
    await publish($, state)
    return state
  })
  const state = await loading
  // A session that ended and began again while this read ran must not keep its answer.
  return (await read($, deferAtom)) ?? state
}

async function publish($: EngineInterface, state: DeferState) {
  await update($, deferAtom, () => state)
  await setStatusPart($, 'defer', statusText(state))
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
    let state = await ensure($)
    if (word === 'on' || word === 'off') {
      if (word === 'on' && !state.stateDir) {
        await publish($, state)
        return { text: `Defer cannot be turned on: ${state.reason ?? 'no state directory is configured for this project (dbt.deferConfigPerProject).'}` }
      }
      state = { ...state, override: word === 'on' }
      await publish($, state)
      return { text: `Defer ${word} for this session.\n${describe(state)}` }
    }
    if (word === 'reset') {
      state = await load($, null)
      await publish($, state)
      return { text: `Defer and target back to the project's settings.\n${describe(state)}` }
    }
    if (word === '' || word === 'status') {
      return { text: describe(state) }
    }
    return { text: 'Usage: /defer [status|on|off|reset]' }
  })

  on('command.run', { command: 'target' }, async ($, e) => {
    const name = e.args.trim()
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
    state = { ...state, target: name }
    await publish($, state)
    return { text: `dbt commands now run with --target ${name} (this session).` }
  })
}

/** After the session started: registers the commands. The project's setting is read when first needed. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  await $.command.register({ name: 'defer', description: "Show or set whether dbt commands defer to the production manifest", argumentHint: '[status|on|off|reset]' })
  await $.command.register({ name: 'target', description: "Set the dbt target for this session's dbt commands", argumentHint: '[<name>|reset]' })
  // A new session starts from the project's own settings, not from the last one's overrides.
  loading = null
  await update($, deferAtom, () => null)
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
  // Most commands name no dbt: they never cost the settings read.
  if (!/\bdbt\b/.test(e.command)) return null
  const state = await ensure($)
  if (!state.projectDir) return null
  const command = rewriteDeferCommand(e.command, effective(state))
  return command === e.command ? null : command
}

/** `{ deny }` refuses the Bash call; null lets it run. */
export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  return null
}

export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {}

/** `file.before` holds the text from before the edit only when `editReadsBefore` is true. */
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
