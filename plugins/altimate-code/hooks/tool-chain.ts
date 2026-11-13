// The one `tool.call` hook the features share. Bash and file-edit handling runs in fixed phases, so
// a rewrite is seen by the gate and by what runs after:
//
//   bashRewrite → bashGate → next(e) → bashAfter → editAfter → readOrEditAfter
//
// Within a phase the features run in the order features/index.ts calls them. A feature that throws is
// logged and skipped: its failure never stops or alters the call on its own. After-phases are awaited,
// so they stay quick and leave slow work to `later`. Context lines they return are appended to the
// call's result, after any the call already carries.
import type { On, ToolCallInput, ToolCallResult } from 'claude-code'

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
export type EditedFile = { path: string; before: string | null }

/** Context lines for Claude, appended to the call's result. */
export type ContextLines = readonly string[] | void | null | undefined

export type Phase = 'bashRewrite' | 'bashGate' | 'bashAfter' | 'editAfter' | 'readOrEditAfter'

/** The phases in the order a call goes through them; `next(e)` runs between bashGate and bashAfter. */
export const PHASES: readonly Phase[] = ['bashRewrite', 'bashGate', 'bashAfter', 'editAfter', 'readOrEditAfter']

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
}

/** The phases before the call: rewrites, then the gate. `deny` set means the call must not run. */
export async function beforeCall(input: ToolCallInput, steps: ChainSteps): Promise<{ e: ToolCallInput; deny: { deny: string } | null; before: string | null }> {
  let e = input
  const bash = bashCallOf(e)
  if (bash) {
    const command = await steps.bashRewrite(bash)
    if (command !== bash.command) e = { ...e, command } as ToolCallInput
    const deny = await steps.bashGate({ ...bash, command })
    if (deny) return { e, deny, before: null }
  }
  const path = filePathOf(e)
  const before = path && EDIT_TOOLS.has(e.tool) && steps.readsBefore ? await steps.readBefore(path).catch(() => null) : null
  return { e, deny: null, before }
}

/** The phases after the call ran: bashAfter, editAfter, readOrEditAfter; their lines go to `context`. */
export async function afterCall(e: ToolCallInput, result: ToolCallResult, before: string | null, steps: ChainSteps): Promise<ToolCallResult> {
  if (result.deny !== undefined) return result
  const lines: string[] = []
  const bash = bashCallOf(e)
  if (bash) lines.push(...(await steps.bashAfter(bash, result)))
  const path = filePathOf(e)
  if (path && !result.isError) {
    if (EDIT_TOOLS.has(e.tool)) lines.push(...(await steps.editAfter(e as FileCall, result, { path, before })))
    lines.push(...(await steps.readOrEditAfter(e as FileCall, result, { path })))
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
      readBefore: path => $.fs.read(path),
      readsBefore: EDIT_READS_BEFORE,
    }
    // The chain failing never stops the call: it then runs as it came, and its result goes back as is.
    const pre = await beforeCall(input, steps).catch(() => ({ e: input, deny: null, before: null }))
    if (pre.deny) return pre.deny
    const result = await next(pre.e)
    return afterCall(pre.e, result, pre.before, steps).catch(() => result)
  })
}
