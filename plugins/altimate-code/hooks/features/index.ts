// The dbt Power User features, each in its own file here, and the one place that calls them, in a
// fixed order: runs, defer, toModel, comments, cost, health, sqlGraph, docs, cteProfile, savings. The dbt
// helpers (hooks/dbt-mods.tsx: compile and validate, Explain and Fix, the Query results pane, model
// context, the doctor) are called last, in the same phases and band; they have no status-line part.
//
// A plugin hooks each shared event once (a second hook on an event without a matcher is refused), and
// the engine refuses `$` handed to anything but a function it can name, so this file calls every
// feature's functions by name instead of looping over a list. A feature fills in its own file only.
// A function that throws, at once or as a rejection, is logged and skipped: one feature's failure never stops another or the call. A `register` failure is silent (`$` is not available at load).
import type { Args, EngineInterface, EventResult, On, PluginOptions, RenderElement, ToolCallInput, ToolCallResult } from 'claude-code'

import type { BashCall, EditedFile, FileCall } from '../tool-chain'
import {
  CHECK_HOLD_MS as dbtModsCheckHoldMs,
  bandDbtMods,
  dbtModsBashAfter,
  dbtModsCallStart,
  dbtModsEditAfter,
  dbtModsReadOrEditAfter,
  endDbtMods,
  newTurnDbtMods,
  registerDbtMods,
  sessionStartDbtMods,
} from '../dbt-mods'
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
  bashDropped as runsBashDropped,
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
import {
  register as savingsRegister,
  sessionStart as savingsSessionStart,
  turnStart as savingsTurnStart,
  turnComplete as savingsTurnComplete,
  sessionEnd as savingsSessionEnd,
  bandLine as savingsBandLine,
  bashRewrite as savingsBashRewrite,
  bashGate as savingsBashGate,
  bashAfter as savingsBashAfter,
  editAfter as savingsEditAfter,
  readOrEditAfter as savingsReadOrEditAfter,
  editReadsBefore as savingsEditReadsBefore,
} from './savings'

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

/**
 * Runs one feature function and logs a failure, whether it throws at once or rejects later, so a feature
 * never breaks the phase it runs in. The function's value, or nothing when it failed.
 */
export async function attempt<T>($: EngineInterface, id: string, part: string, run: () => T | Promise<T>): Promise<Awaited<T> | void> {
  try {
    return await run()
  } catch (error) {
    failed($, id, part, error)
  }
}

/** Registers every feature's own hooks. */
export function registerFeatures(on: On, context: FeatureContext) {
  // One feature's register throwing (a duplicate command, a refused matcher) must not stop the others or the tool hook after them.
  try {
    runsRegister(on, context)
  } catch {}
  try {
    deferRegister(on, context)
  } catch {}
  try {
    toModelRegister(on, context)
  } catch {}
  try {
    commentsRegister(on, context)
  } catch {}
  try {
    costRegister(on, context)
  } catch {}
  try {
    healthRegister(on, context)
  } catch {}
  try {
    sqlGraphRegister(on, context)
  } catch {}
  try {
    docsRegister(on, context)
  } catch {}
  try {
    cteProfileRegister(on, context)
  } catch {}
  try {
    savingsRegister(on, context)
  } catch {}
  try {
    registerDbtMods(on, context)
  } catch {}
}

export async function featuresSessionStart($: EngineInterface, e: Args<'session.start'>) {
  await attempt($, 'runs', 'sessionStart', () => runsSessionStart($, e))
  await attempt($, 'defer', 'sessionStart', () => deferSessionStart($, e))
  await attempt($, 'toModel', 'sessionStart', () => toModelSessionStart($, e))
  await attempt($, 'comments', 'sessionStart', () => commentsSessionStart($, e))
  await attempt($, 'cost', 'sessionStart', () => costSessionStart($, e))
  await attempt($, 'health', 'sessionStart', () => healthSessionStart($, e))
  await attempt($, 'sqlGraph', 'sessionStart', () => sqlGraphSessionStart($, e))
  await attempt($, 'docs', 'sessionStart', () => docsSessionStart($, e))
  await attempt($, 'cteProfile', 'sessionStart', () => cteProfileSessionStart($, e))
  await attempt($, 'savings', 'sessionStart', () => savingsSessionStart($, e))
  await attempt($, 'dbtMods', 'sessionStart', () => sessionStartDbtMods($, e))
}

export async function featuresTurnStart($: EngineInterface, e: Args<'turn.start'>) {
  await attempt($, 'runs', 'turnStart', () => runsTurnStart($, e))
  await attempt($, 'defer', 'turnStart', () => deferTurnStart($, e))
  await attempt($, 'toModel', 'turnStart', () => toModelTurnStart($, e))
  await attempt($, 'comments', 'turnStart', () => commentsTurnStart($, e))
  await attempt($, 'cost', 'turnStart', () => costTurnStart($, e))
  await attempt($, 'health', 'turnStart', () => healthTurnStart($, e))
  await attempt($, 'sqlGraph', 'turnStart', () => sqlGraphTurnStart($, e))
  await attempt($, 'docs', 'turnStart', () => docsTurnStart($, e))
  await attempt($, 'cteProfile', 'turnStart', () => cteProfileTurnStart($, e))
  await attempt($, 'savings', 'turnStart', () => savingsTurnStart($, e))
  await attempt($, 'dbtMods', 'turnStart', () => newTurnDbtMods(e))
}

export async function featuresTurnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {
  await attempt($, 'runs', 'turnComplete', () => runsTurnComplete($, e, out))
  await attempt($, 'defer', 'turnComplete', () => deferTurnComplete($, e, out))
  await attempt($, 'toModel', 'turnComplete', () => toModelTurnComplete($, e, out))
  await attempt($, 'comments', 'turnComplete', () => commentsTurnComplete($, e, out))
  await attempt($, 'cost', 'turnComplete', () => costTurnComplete($, e, out))
  await attempt($, 'health', 'turnComplete', () => healthTurnComplete($, e, out))
  await attempt($, 'sqlGraph', 'turnComplete', () => sqlGraphTurnComplete($, e, out))
  await attempt($, 'docs', 'turnComplete', () => docsTurnComplete($, e, out))
  await attempt($, 'cteProfile', 'turnComplete', () => cteProfileTurnComplete($, e, out))
  await attempt($, 'savings', 'turnComplete', () => savingsTurnComplete($, e, out))
}

export async function featuresSessionEnd($: EngineInterface, e: Args<'session.end'>) {
  await attempt($, 'runs', 'sessionEnd', () => runsSessionEnd($, e))
  await attempt($, 'defer', 'sessionEnd', () => deferSessionEnd($, e))
  await attempt($, 'toModel', 'sessionEnd', () => toModelSessionEnd($, e))
  await attempt($, 'comments', 'sessionEnd', () => commentsSessionEnd($, e))
  await attempt($, 'cost', 'sessionEnd', () => costSessionEnd($, e))
  await attempt($, 'health', 'sessionEnd', () => healthSessionEnd($, e))
  await attempt($, 'sqlGraph', 'sessionEnd', () => sqlGraphSessionEnd($, e))
  await attempt($, 'docs', 'sessionEnd', () => docsSessionEnd($, e))
  await attempt($, 'cteProfile', 'sessionEnd', () => cteProfileSessionEnd($, e))
  await attempt($, 'savings', 'sessionEnd', () => savingsSessionEnd($, e))
  await attempt($, 'dbtMods', 'sessionEnd', () => endDbtMods($))
}

/** Each feature's band line, in order, with its id; a feature with nothing to say is left out. */
export async function featureBandLines($: EngineInterface, ui: BandUi): Promise<{ id: string; line: RenderElement }[]> {
  const lines: { id: string; line: RenderElement }[] = []
  const add = (id: string, line: RenderElement | null | void) => {
    if (line) lines.push({ id, line })
  }
  add('runs', await attempt($, 'runs', 'bandLine', () => runsBandLine($, ui)))
  add('defer', await attempt($, 'defer', 'bandLine', () => deferBandLine($, ui)))
  add('toModel', await attempt($, 'toModel', 'bandLine', () => toModelBandLine($, ui)))
  add('comments', await attempt($, 'comments', 'bandLine', () => commentsBandLine($, ui)))
  add('cost', await attempt($, 'cost', 'bandLine', () => costBandLine($, ui)))
  add('health', await attempt($, 'health', 'bandLine', () => healthBandLine($, ui)))
  add('sqlGraph', await attempt($, 'sqlGraph', 'bandLine', () => sqlGraphBandLine($, ui)))
  add('docs', await attempt($, 'docs', 'bandLine', () => docsBandLine($, ui)))
  add('cteProfile', await attempt($, 'cteProfile', 'bandLine', () => cteProfileBandLine($, ui)))
  add('savings', await attempt($, 'savings', 'bandLine', () => savingsBandLine($, ui)))
  add('dbtMods', await attempt($, 'dbtMods', 'bandLine', () => bandDbtMods($, ui)))
  return lines
}

/** The command after every feature's rewrite, each seeing the one before's. */
export async function featuresBashRewrite($: EngineInterface, e: BashCall): Promise<string> {
  let command = e.command
  const take = (next: string | null | void) => {
    if (typeof next === 'string' && next.trim() !== '') command = next
  }
  take(await attempt($, 'runs', 'bashRewrite', () => runsBashRewrite($, { ...e, command })))
  take(await attempt($, 'defer', 'bashRewrite', () => deferBashRewrite($, { ...e, command })))
  take(await attempt($, 'toModel', 'bashRewrite', () => toModelBashRewrite($, { ...e, command })))
  take(await attempt($, 'comments', 'bashRewrite', () => commentsBashRewrite($, { ...e, command })))
  take(await attempt($, 'cost', 'bashRewrite', () => costBashRewrite($, { ...e, command })))
  take(await attempt($, 'health', 'bashRewrite', () => healthBashRewrite($, { ...e, command })))
  take(await attempt($, 'sqlGraph', 'bashRewrite', () => sqlGraphBashRewrite($, { ...e, command })))
  take(await attempt($, 'docs', 'bashRewrite', () => docsBashRewrite($, { ...e, command })))
  take(await attempt($, 'cteProfile', 'bashRewrite', () => cteProfileBashRewrite($, { ...e, command })))
  take(await attempt($, 'savings', 'bashRewrite', () => savingsBashRewrite($, { ...e, command })))
  return command
}

/** The first feature's refusal of the Bash call, or null. */
export async function featuresBashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  let gate: { deny: string } | null = null
  const take = (next: { deny: string } | null | void) => {
    if (!gate && next && typeof next.deny === 'string') gate = { deny: next.deny }
  }
  if (!gate) take(await attempt($, 'runs', 'bashGate', () => runsBashGate($, e)))
  if (!gate) take(await attempt($, 'defer', 'bashGate', () => deferBashGate($, e)))
  if (!gate) take(await attempt($, 'toModel', 'bashGate', () => toModelBashGate($, e)))
  if (!gate) take(await attempt($, 'comments', 'bashGate', () => commentsBashGate($, e)))
  if (!gate) take(await attempt($, 'cost', 'bashGate', () => costBashGate($, e)))
  if (!gate) take(await attempt($, 'health', 'bashGate', () => healthBashGate($, e)))
  if (!gate) take(await attempt($, 'sqlGraph', 'bashGate', () => sqlGraphBashGate($, e)))
  if (!gate) take(await attempt($, 'docs', 'bashGate', () => docsBashGate($, e)))
  if (!gate) take(await attempt($, 'cteProfile', 'bashGate', () => cteProfileBashGate($, e)))
  if (!gate) take(await attempt($, 'savings', 'bashGate', () => savingsBashGate($, e)))
  return gate
}

/**
 * Before a call runs, after the rewrites and the gate: what a feature needs to know of the call as it was
 * then (the conversation it is in, the folder a command starts in). It cannot refuse or change the call.
 */
export async function featuresCallStart($: EngineInterface, e: ToolCallInput): Promise<void> {
  await attempt($, 'dbtMods', 'callStart', () => dbtModsCallStart($, e))
}

/** A Bash call that a gate refused, or whose result is a refusal, never reaches bashAfter: the features that kept it let go. */
export async function featuresBashDropped($: EngineInterface, e: BashCall): Promise<void> {
  await attempt($, 'runs', 'bashDropped', () => runsBashDropped($, e))
}

/** The context lines every feature adds after a Bash call ran. */
export async function featuresBashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<string[]> {
  const lines: string[] = []
  addLines(lines, await attempt($, 'runs', 'bashAfter', () => runsBashAfter($, e, result)))
  addLines(lines, await attempt($, 'defer', 'bashAfter', () => deferBashAfter($, e, result)))
  addLines(lines, await attempt($, 'toModel', 'bashAfter', () => toModelBashAfter($, e, result)))
  addLines(lines, await attempt($, 'comments', 'bashAfter', () => commentsBashAfter($, e, result)))
  addLines(lines, await attempt($, 'cost', 'bashAfter', () => costBashAfter($, e, result)))
  addLines(lines, await attempt($, 'health', 'bashAfter', () => healthBashAfter($, e, result)))
  addLines(lines, await attempt($, 'sqlGraph', 'bashAfter', () => sqlGraphBashAfter($, e, result)))
  addLines(lines, await attempt($, 'docs', 'bashAfter', () => docsBashAfter($, e, result)))
  addLines(lines, await attempt($, 'cteProfile', 'bashAfter', () => cteProfileBashAfter($, e, result)))
  addLines(lines, await attempt($, 'savings', 'bashAfter', () => savingsBashAfter($, e, result)))
  addLines(lines, await attempt($, 'dbtMods', 'bashAfter', () => dbtModsBashAfter($, e, result)))
  return lines
}

/**
 * How long the edit phase may take: the dbt helpers hold an edit's result for up to their check's wait
 * (dbt-mods.tsx), so the phase's deadline allows that and a little more.
 */
export const EDIT_AFTER_TIMEOUT_MS = dbtModsCheckHoldMs + 5_000

/** Whether any feature's `editAfter` needs the file's text from before the edit. */
export const EDIT_READS_BEFORE: boolean = runsEditReadsBefore || deferEditReadsBefore || toModelEditReadsBefore || commentsEditReadsBefore || costEditReadsBefore || healthEditReadsBefore || sqlGraphEditReadsBefore || docsEditReadsBefore || cteProfileEditReadsBefore || savingsEditReadsBefore

/** The context lines every feature adds after an edit landed. */
export async function featuresEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<string[]> {
  const lines: string[] = []
  addLines(lines, await attempt($, 'runs', 'editAfter', () => runsEditAfter($, e, result, runsEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'defer', 'editAfter', () => deferEditAfter($, e, result, deferEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'toModel', 'editAfter', () => toModelEditAfter($, e, result, toModelEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'comments', 'editAfter', () => commentsEditAfter($, e, result, commentsEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'cost', 'editAfter', () => costEditAfter($, e, result, costEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'health', 'editAfter', () => healthEditAfter($, e, result, healthEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'sqlGraph', 'editAfter', () => sqlGraphEditAfter($, e, result, sqlGraphEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'docs', 'editAfter', () => docsEditAfter($, e, result, docsEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'cteProfile', 'editAfter', () => cteProfileEditAfter($, e, result, cteProfileEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'savings', 'editAfter', () => savingsEditAfter($, e, result, savingsEditReadsBefore ? file : { path: file.path, before: null })))
  addLines(lines, await attempt($, 'dbtMods', 'editAfter', () => dbtModsEditAfter($, e, result, file)))
  return lines
}

/** The context lines every feature adds after a read or an edit succeeded. */
export async function featuresReadOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<string[]> {
  const lines: string[] = []
  addLines(lines, await attempt($, 'runs', 'readOrEditAfter', () => runsReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'defer', 'readOrEditAfter', () => deferReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'toModel', 'readOrEditAfter', () => toModelReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'comments', 'readOrEditAfter', () => commentsReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'cost', 'readOrEditAfter', () => costReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'health', 'readOrEditAfter', () => healthReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'sqlGraph', 'readOrEditAfter', () => sqlGraphReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'docs', 'readOrEditAfter', () => docsReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'cteProfile', 'readOrEditAfter', () => cteProfileReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'savings', 'readOrEditAfter', () => savingsReadOrEditAfter($, e, result, file)))
  addLines(lines, await attempt($, 'dbtMods', 'readOrEditAfter', () => dbtModsReadOrEditAfter($, e, result, file)))
  return lines
}

function addLines(lines: string[], added: readonly unknown[] | null | void) {
  if (Array.isArray(added)) for (const line of added) if (typeof line === 'string' && line !== '') lines.push(line)
}
