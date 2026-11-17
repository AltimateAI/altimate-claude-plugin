// The one `tool.call` hook the features share. Bash and file-edit handling runs in fixed phases, so
// a rewrite is seen by the gate and by what runs after:
//
//   bashRewrite → bashGate → next(e) → bashAfter → editAfter → readOrEditAfter
//
// Within a phase the features run in the order features/index.ts calls them. A feature that throws is
// logged and skipped: its failure never stops or alters the call on its own. After-phases are awaited,
// so they stay quick and leave slow work to `later`. Context lines they return are appended to the
// call's result, after any the call already carries. Each phase has a deadline (PHASE_TIMEOUT_MS): one
// that does not answer in time is logged and the call goes on as if no feature had spoken in it.
import type { On, ToolCallInput, ToolCallResult } from 'claude-code'

import { within } from './altimate-cli'
import {
  EDIT_READS_BEFORE,
  featuresBashAfter,
  featuresBashGate,
  featuresBashRewrite,
  featuresEditAfter,
  featuresReadOrEditAfter,
} from './features'

export type BashCall = ToolCallInput & { tool: 'Bash'; command: string }
export type FileCall = ToolCallInput & { tool: 'Read' | 'Edit' | 'Write' | 'MultiEdit'; file_path: string }
/**
 * The file an edit landed in. `before` is its text before the call, read only when a feature asks
 * for it (`editReadsBefore`); null when not read, missing, or too big for `$.fs.read`.
 */
export type EditedFile = { path: string; before: string | null; beforeUnknown?: boolean }

/** Context lines for Claude, appended to the call's result. */
export type ContextLines = readonly string[] | void | null | undefined

export type Phase = 'bashRewrite' | 'bashGate' | 'bashAfter' | 'editAfter' | 'readOrEditAfter'

/** The phases in the order a call goes through them; `next(e)` runs between bashGate and bashAfter. */
export const PHASES: readonly Phase[] = ['bashRewrite', 'bashGate', 'bashAfter', 'editAfter', 'readOrEditAfter']

/**
 * How long one phase may take, in milliseconds. A phase that runs longer is given up on: the call is
 * passed through unchanged (no refusal, no rewrite, no added context) and the timeout is logged.
 *
 * The deadline covers all the features' work in a phase together, not each feature: a gate still running at it
 * is given up on and the call runs. A gate that must hold the call therefore bounds its own check well inside
 * this and returns `{ deny }` when the check runs out of time.
 */
export const PHASE_TIMEOUT_MS = 5_000

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/** The Bash call in `e`, or null when it is no Bash call with a command. */
export function bashCallOf(e: ToolCallInput): BashCall | null {
  return e.tool === 'Bash' && typeof (e as { command?: unknown }).command === 'string' ? (e as BashCall) : null
}

/** The file a Read, Edit, MultiEdit or Write call names, or null. */
export function filePathOf(e: ToolCallInput): string | null {
  const path = (e as { file_path?: unknown }).file_path
  return (e.tool === 'Read' || EDIT_TOOLS.has(e.tool)) && typeof path === 'string' ? path : null
}

/** `result` with `lines` appended to its context; the result itself when there are none. */
export function withContext(result: ToolCallResult, lines: readonly string[]): ToolCallResult {
  if (lines.length === 0) return result
  return { ...result, context: [...(result.context ?? []), ...lines] } as ToolCallResult
}

/** What each phase does, for one call; the hook binds them to the features (features/index.ts). */
export type ChainSteps = {
  bashRewrite: (e: BashCall) => Promise<string>
  bashGate: (e: BashCall) => Promise<{ deny: string } | null>
  bashAfter: (e: BashCall, result: ToolCallResult) => Promise<string[]>
  editAfter: (e: FileCall, result: ToolCallResult, file: EditedFile) => Promise<string[]>
  readOrEditAfter: (e: FileCall, result: ToolCallResult, file: { path: string }) => Promise<string[]>
  /** The file's text before an edit; called only when `readsBefore` is set. */
  readBefore: (path: string) => Promise<string | null>
  readsBefore: boolean
  /** Runs one phase's work under its deadline: null when the work did not finish in time or failed. */
  limit: <T>(work: Promise<T>) => Promise<T | null>
  /** Where a phase that timed out is logged. */
  log: (text: string) => void
}

/** The phase's value, or `fallback` (logged) when it ran out of time, failed or threw. */
async function bounded<T>(steps: ChainSteps, phase: Phase | 'readBefore', fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    // Wrapped, so a legitimate null value is told apart from the deadline's null.
    const done = await steps.limit(Promise.resolve().then(run).then(value => ({ value })))
    if (done) return done.value
  } catch {
    // The deadline itself failed: only this phase is dropped, the later ones (the gate) still run.
  }
  try {
    steps.log(`tool chain · ${phase} did not finish within ${PHASE_TIMEOUT_MS} ms or failed: the call goes on unchanged`)
  } catch {
    // A logger that throws does not drop the phases after this one.
  }
  return fallback
}

/** The phases before the call: rewrites, then the gate. `deny` set means the call must not run. */
export async function beforeCall(input: ToolCallInput, steps: ChainSteps): Promise<{ e: ToolCallInput; deny: { deny: string } | null; before: string | null; beforeUnknown: boolean }> {
  let e = input
  const bash = bashCallOf(e)
  if (bash) {
    const command = await bounded(steps, 'bashRewrite', bash.command, () => steps.bashRewrite(bash))
    if (command !== bash.command) e = { ...e, command } as ToolCallInput
    const deny = await bounded(steps, 'bashGate', null, () => steps.bashGate({ ...bash, command }))
    if (deny) return { e, deny, before: null, beforeUnknown: false }
  }
  const path = filePathOf(e)
  // `undefined` is a read that did not finish or failed, told apart from `null`, a file that did not exist.
  const read = path && EDIT_TOOLS.has(e.tool) && steps.readsBefore ? await bounded<string | null | undefined>(steps, 'readBefore', undefined, () => steps.readBefore(path)) : null
  return { e, deny: null, before: read ?? null, beforeUnknown: read === undefined }
}

/** The phases after the call ran: bashAfter, editAfter, readOrEditAfter; their lines go to `context`. */
export async function afterCall(e: ToolCallInput, result: ToolCallResult, before: string | null, steps: ChainSteps, beforeUnknown = false): Promise<ToolCallResult> {
  if (result.deny !== undefined) return result
  const lines: string[] = []
  const bash = bashCallOf(e)
  if (bash) lines.push(...(await bounded<string[]>(steps, 'bashAfter', [], () => steps.bashAfter(bash, result))))
  const path = filePathOf(e)
  if (path && !result.isError) {
    if (EDIT_TOOLS.has(e.tool)) lines.push(...(await bounded<string[]>(steps, 'editAfter', [], () => steps.editAfter(e as FileCall, result, { path, before, beforeUnknown }))))
    lines.push(...(await bounded<string[]>(steps, 'readOrEditAfter', [], () => steps.readOrEditAfter(e as FileCall, result, { path }))))
  }
  return withContext(result, lines)
}

/**
 * Registers the chain's `tool.call` hook. It names the tools it handles, since a plugin holds only one
 * `tool.call` hook without a matcher and the lineage half's is that one.
 */
export function installToolChain(on: On) {
  on('tool.call', { tool: /^(Bash|Read|Edit|Write|MultiEdit)$/ }, async ($, input, next) => {
    const steps: ChainSteps = {
      bashRewrite: e => featuresBashRewrite($, e),
      bashGate: e => featuresBashGate($, e),
      bashAfter: (e, result) => featuresBashAfter($, e, result),
      editAfter: (e, result, file) => featuresEditAfter($, e, result, file),
      readOrEditAfter: (e, result, file) => featuresReadOrEditAfter($, e, result, file),
      // A file that is not there yet (a Write that creates it) is `null`; one that is there but cannot be read rejects.
      readBefore: async path => ((await $.fs.exists(path)) ? $.fs.read(path) : null),
      readsBefore: EDIT_READS_BEFORE,
      limit: work => within($, PHASE_TIMEOUT_MS, work),
      log: text => $.ui.log(text, { to: 'debug' }),
    }
    // The chain failing never stops the call: it then runs as it came, and its result goes back as is.
    const pre = await beforeCall(input, steps).catch(() => ({ e: input, deny: null, before: null, beforeUnknown: false }))
    if (pre.deny) return pre.deny
    const result = await next(pre.e)
    return afterCall(pre.e, result, pre.before, steps, pre.beforeUnknown).catch(() => result)
  })
}
