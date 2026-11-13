// Project health: new DataPilot insights on the models Claude changed.
//
// At session start a baseline run records every (model, insight) pair the project already has. When a
// turn changed model files (.sql, .yml), the check runs again and the pairs the baseline lacks, on the
// models changed so far this session, are the new issues: the band shows them, and with
// `healthBlocksPush` on, `git push` is refused while any remain. The check is altimate-code's
// `dbt_health` tool, which needs write permission (it starts the dbt adapter), so it goes through
// the CLI.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, PluginOptions, RenderElement, ToolCallResult } from 'claude-code'

import type { HealthState } from '../../types'
import { later, runTool } from '../altimate-cli'
import { setStatusPart } from '../status-line'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { BandUi, FeatureContext } from './index'

export type HealthInsight = { uniqueId: string; path: string; name: string; severity: string; message: string; recommendation: string }
type HealthRun = { insights: HealthInsight[] } | { problem: string }

const COMMAND = 'health'
/** A check can take minutes: the dbt adapter starts, then DataPilot reads the manifest. */
const CHECK_MS = 9 * 60_000
/** The most issues the push refusal and the report list. */
const LISTED = 10
const NEEDS_CLI = 'Project health needs an altimate-code build newer than 0.12.10 (one with the dbt_health tool)'

const healthAtom = atom(
  { plugin: 'altimate-code', key: 'health' } as const,
  null as HealthState | null,
)

const fresh = (): HealthState => ({ baseline: null, pending: [], touched: [], issues: [], problem: null, running: false })

let options: PluginOptions = {}
/** Bumped at each session start: a run that started before a /clear or reload doesn't write its answer. */
let generation = 0

export const pairKey = (i: Pick<HealthInsight, 'uniqueId' | 'name'>) => `${i.uniqueId}\u0000${i.name}`

/** The model a file is, by its path: the project-relative path DataPilot reports ends the file's path. */
export function modelsOfFile(file: string, insights: readonly HealthInsight[]): Set<string> {
  const ids = new Set<string>()
  const norm = file.replace(/\\/g, '/')
  for (const i of insights) if (i.path && (norm === i.path || norm.endsWith(`/${i.path.replace(/\\/g, '/')}`))) ids.add(i.uniqueId)
  return ids
}

/** The model names a properties (.yml) file lists, as `unique_id` last segments. */
export function modelNamesInYaml(text: string): string[] {
  const names: string[] = []
  let inModels = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inModels = /^models\s*:/.test(line)
    else if (inModels) {
      const m = /^\s{0,4}-\s+name:\s*['"]?([\w.-]+)['"]?\s*$/.exec(line)
      if (m?.[1]) names.push(m[1])
    }
  }
  return names
}

/** The insights the baseline lacks, on the given models. */
export function newIssues(insights: readonly HealthInsight[], baseline: readonly string[], models: ReadonlySet<string>): HealthInsight[] {
  const had = new Set(baseline)
  return insights.filter(i => models.has(i.uniqueId) && !had.has(pairKey(i)))
}

const shortName = (id: string) => id.split('.').pop() ?? id

/** "2 new health issues · stg_orders: hard coded references · /health" */
export function bandText(issues: readonly HealthInsight[]): string {
  const first = issues[0]
  if (!first) return ''
  const more = new Set(issues.map(i => shortName(i.uniqueId))).size - 1
  return `${issues.length} new health issue${issues.length === 1 ? '' : 's'} · ${shortName(first.uniqueId)}: ${first.name.toLowerCase()}${more > 0 ? ` (+${more} more model${more === 1 ? '' : 's'})` : ''} · /${COMMAND}`
}

export function reportText(issues: readonly HealthInsight[]): string {
  const lines = issues.slice(0, LISTED).map(i => `- ${shortName(i.uniqueId)}: ${i.name.toLowerCase()} (${i.severity.toLowerCase()}) ${i.message}${i.recommendation ? ` → ${i.recommendation}` : ''}`)
  if (issues.length > LISTED) lines.push(`- and ${issues.length - LISTED} more`)
  return lines.join('\n')
}

/** Whether a Bash command contains a `git push` (after `&&`, `||`, `;`, `|` or a newline, past env assignments and git's own options). */
export function isGitPush(command: string): boolean {
  return /(?:^|&&|\|\||[;|\n])\s*(?:\w+=\S*\s+)*git\s+(?:(?:-C|-c)\s+\S+\s+|--[\w-]+(?:=\S+)?\s+)*push(?:\s|$)/.test(command)
}

/** The `dbt_health` arguments for the plugin's `healthConfigPath` setting. */
export function toolArgs(configPath: unknown): Record<string, unknown> {
  const config = typeof configPath === 'string' ? configPath.trim() : ''
  return config ? { config_path: config } : {}
}

/** Asks altimate-code's dbt_health for the project's insights. */
async function check($: EngineInterface): Promise<HealthRun> {
  const until = (await $.clock.now()) + CHECK_MS
  let result: Awaited<ReturnType<typeof runTool>>
  try {
    result = await runTool($, 'dbt_health', toolArgs(options.healthConfigPath), { write: true, until })
  } catch (error) {
    return { problem: `Project health could not run: ${String(error).split('\n')[0]}` }
  }
  const insights = result.metadata?.insights
  if (result.ok && Array.isArray(insights)) return { insights: insights as HealthInsight[] }
  if (/unknown tool/i.test(result.text)) return { problem: NEEDS_CLI }
  return { problem: `Project health: ${(result.text || 'no answer').split('\n')[0]}` }
}

/** Whether the status line carries the health part now. */
let drawn = false

async function drawStatus($: EngineInterface, state: HealthState | null) {
  const n = state?.issues.length ?? 0
  if (n === 0 && !drawn) return
  drawn = n > 0
  await setStatusPart($, 'health', n > 0 ? `${n} health issue${n === 1 ? '' : 's'}` : null)
}

/** The baseline run: its pairs are what the project already had. */
async function startBaseline($: EngineInterface, mine: number) {
  const run = await check($)
  if (mine !== generation) return
  const state = await update($, healthAtom, prev => {
    const base = prev ?? fresh()
    return 'problem' in run ? { ...base, problem: run.problem } : { ...base, baseline: run.insights.map(pairKey), problem: null }
  })
  void state
}

/** Runs the check over the changes so far; returns the issues, or why it could not. */
async function recheck($: EngineInterface, mine: number): Promise<{ issues: HealthInsight[] } | { problem: string } | null> {
  const before = await read($, healthAtom)
  if (!before?.baseline || before.running) return before?.problem ? { problem: before.problem } : null
  await update($, healthAtom, prev => ({ ...(prev ?? fresh()), running: true }))
  const run = await check($)
  if (mine !== generation) return null
  const touched = new Set<string>()
  let result: { issues: HealthInsight[] } | { problem: string }
  if ('problem' in run) {
    result = { problem: run.problem }
  } else {
    const current = await read($, healthAtom)
    for (const file of current?.touched ?? []) {
      for (const id of modelsOfFile(file, run.insights)) touched.add(id)
    }
    // A changed properties file names its models; one that no insight reports has no insights to match.
    const names = new Set<string>()
    for (const file of current?.touched ?? []) {
      if (/\.ya?ml$/i.test(file)) {
        const text = await $.fs.read(file).catch(() => '')
        for (const name of modelNamesInYaml(text)) names.add(name)
      }
    }
    for (const i of run.insights) if (names.has(shortName(i.uniqueId))) touched.add(i.uniqueId)
    result = { issues: newIssues(run.insights, current?.baseline ?? [], touched) }
  }
  const next = await update($, healthAtom, prev => {
    const base = prev ?? fresh()
    return 'problem' in result ? { ...base, running: false, problem: result.problem } : { ...base, running: false, problem: null, issues: result.issues }
  })
  void next
  await drawStatus($, await read($, healthAtom))
  return result
}

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  options = context.options
  on('command.run', { command: COMMAND }, async $ => {
    const state = await read($, healthAtom)
    if (!state?.baseline && !state?.running) return { text: state?.problem ?? 'Project health has not finished its first check yet.' }
    const mine = generation
    const result = await recheck($, mine)
    if (!result) return { text: 'Project health is still checking.' }
    if ('problem' in result) return { text: result.problem }
    return { text: result.issues.length ? `${bandText(result.issues)}\n${reportText(result.issues)}` : 'No new health issues in the models changed this session.' }
  })
}

/** Whether the session's folder, or one above it, holds a dbt project. */
async function inDbtProject($: EngineInterface): Promise<boolean> {
  let dir = await $.session.root().catch(() => '')
  for (let i = 0; dir && i < 8; i++) {
    if (await $.fs.exists(`${dir}/dbt_project.yml`).catch(() => false)) return true
    const parent = dir.replace(/[\\/][^\\/]*$/, '')
    if (parent === dir) break
    dir = parent
  }
  return false
}

export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  generation += 1
  await update($, healthAtom, () => fresh())
  if (drawn) await drawStatus($, null)
  await $.command.register({ name: COMMAND, description: 'Show the project health issues Claude introduced' })
  // The baseline takes a while (the dbt adapter starts): nothing waits for it. A `-p` run or the SDK has
  // nobody to show it to.
  if (e.isInteractive && (await inDbtProject($))) {
    const mine = generation
    later($, () => startBaseline($, mine))
  }
}

export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

/** After the turn's answer: when model files changed, check again. */
export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {
  if ((e as { agentId?: string }).agentId) return
  const state = await read($, healthAtom)
  if (!state || state.pending.length === 0) return
  await update($, healthAtom, prev => ({ ...(prev ?? fresh()), pending: [] }))
  const mine = generation
  later($, async () => {
    const result = await recheck($, mine)
    if (!result || mine !== generation) return
    if ('problem' in result) {
      // Said once, not at every turn.
      if (result.problem !== state.problem) $.ui.toast(`◆ ${result.problem}`, { timeoutMs: 8000 })
      return
    }
    if (result.issues.length) $.ui.toast(`◆ ${bandText(result.issues)}`, { timeoutMs: 8000 })
  })
}

export async function sessionEnd($: EngineInterface, e: Args<'session.end'>) {
  generation += 1
}

/** This feature's line in the band, under the lineage line; null when there is nothing to say. */
export async function bandLine($: EngineInterface, ui: BandUi): Promise<RenderElement | null> {
  const state = await read($, healthAtom)
  if (!state || state.issues.length === 0) return null
  const { Text } = ui
  return <Text color="warning">{bandText(state.issues)}</Text>
}

export async function bashRewrite($: EngineInterface, e: BashCall): Promise<string | null> {
  return null
}

/** The refusal for `command` when the push gate is on and `issues` are open; null lets the command run. */
export function pushRefusal(blocks: unknown, command: string, issues: readonly HealthInsight[]): { deny: string } | null {
  if (!(blocks === true || blocks === 'true') || !isGitPush(command) || issues.length === 0) return null
  return {
    deny: `git push is held: the models changed this session have ${issues.length} new project health issue${issues.length === 1 ? '' : 's'}.\n${reportText(issues)}\nFix them, or turn off "Project health blocks git push" in the plugin's settings.`,
  }
}

/** With `healthBlocksPush` on, `git push` is refused while the models changed have new health issues. */
export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  if (!isGitPush(e.command)) return null
  const state = await read($, healthAtom)
  return pushRefusal(options.healthBlocksPush, e.command, state?.issues ?? [])
}

export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {}

/** A model file Claude changed is checked at the end of the turn. */
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {
  if (!/\.(sql|ya?ml)$/i.test(file.path)) return
  await update($, healthAtom, prev => {
    const base = prev ?? fresh()
    return {
      ...base,
      pending: base.pending.includes(file.path) ? base.pending : [...base.pending, file.path],
      touched: base.touched.includes(file.path) ? base.touched : [...base.touched, file.path],
    }
  })
}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
