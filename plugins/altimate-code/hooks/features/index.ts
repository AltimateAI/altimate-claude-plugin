// The dbt Power User features, each in its own file here, and the one place that calls them, in a
// fixed order: runs, defer, toModel, comments, cost, health, sqlGraph, docs, cteProfile.
//
// A plugin hooks each shared event once (a second hook on an event without a matcher is refused), and
// the engine refuses `$` handed to anything but a function it can name, so this file calls every
// feature's functions by name instead of looping over a list. A feature fills in its own file only.
// A function that throws is logged and skipped: one feature's failure never stops another or the call.
import type { Args, EngineInterface, EventResult, On, PluginOptions, RenderElement, ToolCallResult } from 'claude-code'

import type { BashCall, EditedFile, FileCall } from '../tool-chain'
import {
  register as runsRegister,
  sessionStart as runsSessionStart,
  turnStart as runsTurnStart,
  turnComplete as runsTurnComplete,
  sessionEnd as runsSessionEnd,
  bandLine as runsBandLine,
  bashRewrite as runsBashRewrite,
  bashGate as runsBashGate,
  bashAfter as runsBashAfter,
  editAfter as runsEditAfter,
  readOrEditAfter as runsReadOrEditAfter,
  editReadsBefore as runsEditReadsBefore,
} from './runs'
import {
  register as deferRegister,
  sessionStart as deferSessionStart,
  turnStart as deferTurnStart,
  turnComplete as deferTurnComplete,
  sessionEnd as deferSessionEnd,
  bandLine as deferBandLine,
  bashRewrite as deferBashRewrite,
  bashGate as deferBashGate,
  bashAfter as deferBashAfter,
  editAfter as deferEditAfter,
  readOrEditAfter as deferReadOrEditAfter,
  editReadsBefore as deferEditReadsBefore,
} from './defer'
import {
  register as toModelRegister,
  sessionStart as toModelSessionStart,
  turnStart as toModelTurnStart,
  turnComplete as toModelTurnComplete,
  sessionEnd as toModelSessionEnd,
  bandLine as toModelBandLine,
  bashRewrite as toModelBashRewrite,
  bashGate as toModelBashGate,
  bashAfter as toModelBashAfter,
  editAfter as toModelEditAfter,
  readOrEditAfter as toModelReadOrEditAfter,
  editReadsBefore as toModelEditReadsBefore,
} from './to-model'
import {
  register as commentsRegister,
  sessionStart as commentsSessionStart,
  turnStart as commentsTurnStart,
  turnComplete as commentsTurnComplete,
  sessionEnd as commentsSessionEnd,
  bandLine as commentsBandLine,
  bashRewrite as commentsBashRewrite,
  bashGate as commentsBashGate,
  bashAfter as commentsBashAfter,
  editAfter as commentsEditAfter,
  readOrEditAfter as commentsReadOrEditAfter,
  editReadsBefore as commentsEditReadsBefore,
} from './comments'
import {
  register as costRegister,
  sessionStart as costSessionStart,
  turnStart as costTurnStart,
  turnComplete as costTurnComplete,
  sessionEnd as costSessionEnd,
  bandLine as costBandLine,
  bashRewrite as costBashRewrite,
  bashGate as costBashGate,
  bashAfter as costBashAfter,
  editAfter as costEditAfter,
  readOrEditAfter as costReadOrEditAfter,
  editReadsBefore as costEditReadsBefore,
} from './cost'
import {
  register as healthRegister,
  sessionStart as healthSessionStart,
  turnStart as healthTurnStart,
  turnComplete as healthTurnComplete,
  sessionEnd as healthSessionEnd,
  bandLine as healthBandLine,
  bashRewrite as healthBashRewrite,
  bashGate as healthBashGate,
  bashAfter as healthBashAfter,
  editAfter as healthEditAfter,
  readOrEditAfter as healthReadOrEditAfter,
  editReadsBefore as healthEditReadsBefore,
} from './health'
import {
  register as sqlGraphRegister,
  sessionStart as sqlGraphSessionStart,
  turnStart as sqlGraphTurnStart,
  turnComplete as sqlGraphTurnComplete,
  sessionEnd as sqlGraphSessionEnd,
  bandLine as sqlGraphBandLine,
  bashRewrite as sqlGraphBashRewrite,
  bashGate as sqlGraphBashGate,
  bashAfter as sqlGraphBashAfter,
  editAfter as sqlGraphEditAfter,
  readOrEditAfter as sqlGraphReadOrEditAfter,
  editReadsBefore as sqlGraphEditReadsBefore,
} from './sql-graph'
import {
  register as docsRegister,
  sessionStart as docsSessionStart,
  turnStart as docsTurnStart,
  turnComplete as docsTurnComplete,
  sessionEnd as docsSessionEnd,
  bandLine as docsBandLine,
  bashRewrite as docsBashRewrite,
  bashGate as docsBashGate,
  bashAfter as docsBashAfter,
  editAfter as docsEditAfter,
  readOrEditAfter as docsReadOrEditAfter,
  editReadsBefore as docsEditReadsBefore,
} from './docs'
import {
  register as cteProfileRegister,
  sessionStart as cteProfileSessionStart,
  turnStart as cteProfileTurnStart,
  turnComplete as cteProfileTurnComplete,
  sessionEnd as cteProfileSessionEnd,
  bandLine as cteProfileBandLine,
  bashRewrite as cteProfileBashRewrite,
  bashGate as cteProfileBashGate,
  bashAfter as cteProfileBashAfter,
  editAfter as cteProfileEditAfter,
  readOrEditAfter as cteProfileReadOrEditAfter,
  editReadsBefore as cteProfileEditReadsBefore,
} from './cte-profile'

export type { FeatureId } from '../status-line'
export { FEATURE_IDS } from '../status-line'

/** The elements a band line draws with: what `$.ui.resolve(e)` gave the band's hook. */
export type BandUi = { Box: any; Button: any; Text: any; [element: string]: any }

/** What a feature's `register` gets. */
export type FeatureContext = {
  /** The plugin's `userConfig` values (`.claude-plugin/plugin.json`), defaults filled in. */
  options: PluginOptions
}

function failed($: EngineInterface, id: string, part: string, error: unknown) {
  try {
    $.ui.log(`${id} · ${part} failed: ${String(error)}`, { to: 'debug' })
  } catch {}
}

/** Registers every feature's own hooks. */
export function registerFeatures(on: On, context: FeatureContext) {
  runsRegister(on, context)
  deferRegister(on, context)
  toModelRegister(on, context)
  commentsRegister(on, context)
  costRegister(on, context)
  healthRegister(on, context)
  sqlGraphRegister(on, context)
  docsRegister(on, context)
  cteProfileRegister(on, context)
}

export async function featuresSessionStart($: EngineInterface, e: Args<'session.start'>) {
  await runsSessionStart($, e).catch(error => failed($, 'runs', 'sessionStart', error))
  await deferSessionStart($, e).catch(error => failed($, 'defer', 'sessionStart', error))
  await toModelSessionStart($, e).catch(error => failed($, 'toModel', 'sessionStart', error))
  await commentsSessionStart($, e).catch(error => failed($, 'comments', 'sessionStart', error))
  await costSessionStart($, e).catch(error => failed($, 'cost', 'sessionStart', error))
  await healthSessionStart($, e).catch(error => failed($, 'health', 'sessionStart', error))
  await sqlGraphSessionStart($, e).catch(error => failed($, 'sqlGraph', 'sessionStart', error))
  await docsSessionStart($, e).catch(error => failed($, 'docs', 'sessionStart', error))
  await cteProfileSessionStart($, e).catch(error => failed($, 'cteProfile', 'sessionStart', error))
}

export async function featuresTurnStart($: EngineInterface, e: Args<'turn.start'>) {
  await runsTurnStart($, e).catch(error => failed($, 'runs', 'turnStart', error))
  await deferTurnStart($, e).catch(error => failed($, 'defer', 'turnStart', error))
  await toModelTurnStart($, e).catch(error => failed($, 'toModel', 'turnStart', error))
  await commentsTurnStart($, e).catch(error => failed($, 'comments', 'turnStart', error))
  await costTurnStart($, e).catch(error => failed($, 'cost', 'turnStart', error))
  await healthTurnStart($, e).catch(error => failed($, 'health', 'turnStart', error))
  await sqlGraphTurnStart($, e).catch(error => failed($, 'sqlGraph', 'turnStart', error))
  await docsTurnStart($, e).catch(error => failed($, 'docs', 'turnStart', error))
  await cteProfileTurnStart($, e).catch(error => failed($, 'cteProfile', 'turnStart', error))
}

export async function featuresTurnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {
  await runsTurnComplete($, e, out).catch(error => failed($, 'runs', 'turnComplete', error))
  await deferTurnComplete($, e, out).catch(error => failed($, 'defer', 'turnComplete', error))
  await toModelTurnComplete($, e, out).catch(error => failed($, 'toModel', 'turnComplete', error))
  await commentsTurnComplete($, e, out).catch(error => failed($, 'comments', 'turnComplete', error))
  await costTurnComplete($, e, out).catch(error => failed($, 'cost', 'turnComplete', error))
  await healthTurnComplete($, e, out).catch(error => failed($, 'health', 'turnComplete', error))
  await sqlGraphTurnComplete($, e, out).catch(error => failed($, 'sqlGraph', 'turnComplete', error))
  await docsTurnComplete($, e, out).catch(error => failed($, 'docs', 'turnComplete', error))
  await cteProfileTurnComplete($, e, out).catch(error => failed($, 'cteProfile', 'turnComplete', error))
}

export async function featuresSessionEnd($: EngineInterface, e: Args<'session.end'>) {
  await runsSessionEnd($, e).catch(error => failed($, 'runs', 'sessionEnd', error))
  await deferSessionEnd($, e).catch(error => failed($, 'defer', 'sessionEnd', error))
  await toModelSessionEnd($, e).catch(error => failed($, 'toModel', 'sessionEnd', error))
  await commentsSessionEnd($, e).catch(error => failed($, 'comments', 'sessionEnd', error))
  await costSessionEnd($, e).catch(error => failed($, 'cost', 'sessionEnd', error))
  await healthSessionEnd($, e).catch(error => failed($, 'health', 'sessionEnd', error))
  await sqlGraphSessionEnd($, e).catch(error => failed($, 'sqlGraph', 'sessionEnd', error))
  await docsSessionEnd($, e).catch(error => failed($, 'docs', 'sessionEnd', error))
  await cteProfileSessionEnd($, e).catch(error => failed($, 'cteProfile', 'sessionEnd', error))
}

/** Each feature's band line, in order, with its id; a feature with nothing to say is left out. */
export async function featureBandLines($: EngineInterface, ui: BandUi): Promise<{ id: string; line: RenderElement }[]> {
  const lines: { id: string; line: RenderElement }[] = []
  const add = (id: string, line: RenderElement | null | void) => {
    if (line) lines.push({ id, line })
  }
  add('runs', await runsBandLine($, ui).catch(error => failed($, 'runs', 'bandLine', error)))
  add('defer', await deferBandLine($, ui).catch(error => failed($, 'defer', 'bandLine', error)))
  add('toModel', await toModelBandLine($, ui).catch(error => failed($, 'toModel', 'bandLine', error)))
  add('comments', await commentsBandLine($, ui).catch(error => failed($, 'comments', 'bandLine', error)))
  add('cost', await costBandLine($, ui).catch(error => failed($, 'cost', 'bandLine', error)))
  add('health', await healthBandLine($, ui).catch(error => failed($, 'health', 'bandLine', error)))
  add('sqlGraph', await sqlGraphBandLine($, ui).catch(error => failed($, 'sqlGraph', 'bandLine', error)))
  add('docs', await docsBandLine($, ui).catch(error => failed($, 'docs', 'bandLine', error)))
  add('cteProfile', await cteProfileBandLine($, ui).catch(error => failed($, 'cteProfile', 'bandLine', error)))
  return lines
}

/** The command after every feature's rewrite, each seeing the one before's. */
export async function featuresBashRewrite($: EngineInterface, e: BashCall): Promise<string> {
  let command = e.command
  const take = (next: string | null | void) => {
    if (typeof next === 'string' && next.trim() !== '') command = next
  }
  take(await runsBashRewrite($, { ...e, command }).catch(error => failed($, 'runs', 'bashRewrite', error)))
  take(await deferBashRewrite($, { ...e, command }).catch(error => failed($, 'defer', 'bashRewrite', error)))
  take(await toModelBashRewrite($, { ...e, command }).catch(error => failed($, 'toModel', 'bashRewrite', error)))
  take(await commentsBashRewrite($, { ...e, command }).catch(error => failed($, 'comments', 'bashRewrite', error)))
  take(await costBashRewrite($, { ...e, command }).catch(error => failed($, 'cost', 'bashRewrite', error)))
  take(await healthBashRewrite($, { ...e, command }).catch(error => failed($, 'health', 'bashRewrite', error)))
  take(await sqlGraphBashRewrite($, { ...e, command }).catch(error => failed($, 'sqlGraph', 'bashRewrite', error)))
  take(await docsBashRewrite($, { ...e, command }).catch(error => failed($, 'docs', 'bashRewrite', error)))
  take(await cteProfileBashRewrite($, { ...e, command }).catch(error => failed($, 'cteProfile', 'bashRewrite', error)))
  return command
}

/** The first feature's refusal of the Bash call, or null. */
export async function featuresBashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  let gate: { deny: string } | null = null
  const take = (next: { deny: string } | null | void) => {
    if (!gate && next && typeof next.deny === 'string') gate = { deny: next.deny }
  }
  if (!gate) take(await runsBashGate($, e).catch(error => failed($, 'runs', 'bashGate', error)))
  if (!gate) take(await deferBashGate($, e).catch(error => failed($, 'defer', 'bashGate', error)))
  if (!gate) take(await toModelBashGate($, e).catch(error => failed($, 'toModel', 'bashGate', error)))
  if (!gate) take(await commentsBashGate($, e).catch(error => failed($, 'comments', 'bashGate', error)))
  if (!gate) take(await costBashGate($, e).catch(error => failed($, 'cost', 'bashGate', error)))
  if (!gate) take(await healthBashGate($, e).catch(error => failed($, 'health', 'bashGate', error)))
  if (!gate) take(await sqlGraphBashGate($, e).catch(error => failed($, 'sqlGraph', 'bashGate', error)))
  if (!gate) take(await docsBashGate($, e).catch(error => failed($, 'docs', 'bashGate', error)))
  if (!gate) take(await cteProfileBashGate($, e).catch(error => failed($, 'cteProfile', 'bashGate', error)))
  return gate
}

/** The context lines every feature adds after a Bash call ran. */
export async function featuresBashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<string[]> {
  const lines: string[] = []
  addLines(lines, await runsBashAfter($, e, result).catch(error => failed($, 'runs', 'bashAfter', error)))
  addLines(lines, await deferBashAfter($, e, result).catch(error => failed($, 'defer', 'bashAfter', error)))
  addLines(lines, await toModelBashAfter($, e, result).catch(error => failed($, 'toModel', 'bashAfter', error)))
  addLines(lines, await commentsBashAfter($, e, result).catch(error => failed($, 'comments', 'bashAfter', error)))
  addLines(lines, await costBashAfter($, e, result).catch(error => failed($, 'cost', 'bashAfter', error)))
  addLines(lines, await healthBashAfter($, e, result).catch(error => failed($, 'health', 'bashAfter', error)))
  addLines(lines, await sqlGraphBashAfter($, e, result).catch(error => failed($, 'sqlGraph', 'bashAfter', error)))
  addLines(lines, await docsBashAfter($, e, result).catch(error => failed($, 'docs', 'bashAfter', error)))
  addLines(lines, await cteProfileBashAfter($, e, result).catch(error => failed($, 'cteProfile', 'bashAfter', error)))
  return lines
}

/** Whether any feature's `editAfter` needs the file's text from before the edit. */
export const EDIT_READS_BEFORE: boolean = runsEditReadsBefore || deferEditReadsBefore || toModelEditReadsBefore || commentsEditReadsBefore || costEditReadsBefore || healthEditReadsBefore || sqlGraphEditReadsBefore || docsEditReadsBefore || cteProfileEditReadsBefore

/** The context lines every feature adds after an edit landed. */
export async function featuresEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<string[]> {
  const lines: string[] = []
  addLines(lines, await runsEditAfter($, e, result, runsEditReadsBefore ? file : { path: file.path, before: null }).catch(error => failed($, 'runs', 'editAfter', error)))
  addLines(lines, await deferEditAfter($, e, result, deferEditReadsBefore ? file : { path: file.path, before: null }).catch(error => failed($, 'defer', 'editAfter', error)))
  addLines(lines, await toModelEditAfter($, e, result, toModelEditReadsBefore ? file : { path: file.path, before: null }).catch(error => failed($, 'toModel', 'editAfter', error)))
  addLines(lines, await commentsEditAfter($, e, result, commentsEditReadsBefore ? file : { path: file.path, before: null }).catch(error => failed($, 'comments', 'editAfter', error)))
  addLines(lines, await costEditAfter($, e, result, costEditReadsBefore ? file : { path: file.path, before: null }).catch(error => failed($, 'cost', 'editAfter', error)))
  addLines(lines, await healthEditAfter($, e, result, healthEditReadsBefore ? file : { path: file.path, before: null }).catch(error => failed($, 'health', 'editAfter', error)))
  addLines(lines, await sqlGraphEditAfter($, e, result, sqlGraphEditReadsBefore ? file : { path: file.path, before: null }).catch(error => failed($, 'sqlGraph', 'editAfter', error)))
  addLines(lines, await docsEditAfter($, e, result, docsEditReadsBefore ? file : { path: file.path, before: null }).catch(error => failed($, 'docs', 'editAfter', error)))
  addLines(lines, await cteProfileEditAfter($, e, result, cteProfileEditReadsBefore ? file : { path: file.path, before: null }).catch(error => failed($, 'cteProfile', 'editAfter', error)))
  return lines
}

/** The context lines every feature adds after a read or an edit succeeded. */
export async function featuresReadOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<string[]> {
  const lines: string[] = []
  addLines(lines, await runsReadOrEditAfter($, e, result, file).catch(error => failed($, 'runs', 'readOrEditAfter', error)))
  addLines(lines, await deferReadOrEditAfter($, e, result, file).catch(error => failed($, 'defer', 'readOrEditAfter', error)))
  addLines(lines, await toModelReadOrEditAfter($, e, result, file).catch(error => failed($, 'toModel', 'readOrEditAfter', error)))
  addLines(lines, await commentsReadOrEditAfter($, e, result, file).catch(error => failed($, 'comments', 'readOrEditAfter', error)))
  addLines(lines, await costReadOrEditAfter($, e, result, file).catch(error => failed($, 'cost', 'readOrEditAfter', error)))
  addLines(lines, await healthReadOrEditAfter($, e, result, file).catch(error => failed($, 'health', 'readOrEditAfter', error)))
  addLines(lines, await sqlGraphReadOrEditAfter($, e, result, file).catch(error => failed($, 'sqlGraph', 'readOrEditAfter', error)))
  addLines(lines, await docsReadOrEditAfter($, e, result, file).catch(error => failed($, 'docs', 'readOrEditAfter', error)))
  addLines(lines, await cteProfileReadOrEditAfter($, e, result, file).catch(error => failed($, 'cteProfile', 'readOrEditAfter', error)))
  return lines
}

function addLines(lines: string[], added: readonly unknown[] | null | void) {
  if (Array.isArray(added)) for (const line of added) if (typeof line === 'string' && line !== '') lines.push(line)
}
