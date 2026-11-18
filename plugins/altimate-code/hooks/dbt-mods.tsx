// The dbt helpers (compile and validate, Explain and Fix, the Query results pane, model context, the doctor).
//
// features/index.ts calls each function below at its moment, in the same phases and band as the other
// features; one with nothing to do stays a no-op. The helpers themselves are filled in by their own change.
import type { Args, EngineInterface, On, PluginOptions, RenderElement, ToolCallResult } from 'claude-code'

/** How long the edit phase may hold an edit's result for a slow check, in milliseconds. */
export const CHECK_HOLD_MS = 30_000

export async function dbtModsCallStart($: EngineInterface, e: { tool: string; agentId?: string }): Promise<void> {}

export async function dbtModsBashAfter($: EngineInterface, e: { tool: string; command: string; agentId?: string }, result: ToolCallResult): Promise<string[]> {
  return []
}

export async function dbtModsEditAfter($: EngineInterface, e: { tool: string; agentId?: string }, result: ToolCallResult, file: { path: string }): Promise<string[]> {
  return []
}

export async function dbtModsReadOrEditAfter($: EngineInterface, e: { tool: string; agentId?: string }, result: ToolCallResult, file: { path: string }): Promise<string[]> {
  return []
}

export async function endDbtMods($: EngineInterface) {}

export function newTurnDbtMods(e: { agentId?: string }) {}

export async function sessionStartDbtMods($: EngineInterface, e: Args<'session.start'>) {}

export async function bandDbtMods($: EngineInterface, ui: { Box: any; Button: any; Text: any }): Promise<RenderElement | null> {
  return null
}

export function registerDbtMods(on: On, context: { options: PluginOptions }) {}
