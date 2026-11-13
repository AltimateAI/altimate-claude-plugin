// Project health: new DataPilot insights on the models Claude changed.
//
// The plugin calls each function below at its moment, in the order features/index.ts fixes; one with
// nothing to do stays a no-op. This feature's own hooks (its commands and panes, each under a matcher
// no other part uses) go in `register`. The events the whole plugin shares (session start and end,
// turns, Bash and file tool calls, the band) come through the other functions, since a plugin hooks
// each of those once. The status-line part is set with `setStatusPart($, 'health', text)`.
import type { Args, EngineInterface, EventResult, On, RenderElement, ToolCallResult } from 'claude-code'

import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { BandUi, FeatureContext } from './index'

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {}

/** After the session started: the place to register commands. */
export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {}

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
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
