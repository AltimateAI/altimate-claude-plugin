// Project health: new DataPilot insights on the models Claude changed.
//
// At session start a baseline run records every (model, insight) pair the project already has. A check
// runs again after the turn in which Claude changed model files (.sql, .yml), and the pairs the
// baseline lacks, on the models those files hold, are the new issues: the band shows them, and with
// `healthBlocksPush` on, `git push` is held until the check of the latest changes is in and refused
// while any issue remains. The check is altimate-code's `dbt_health` tool, which needs write
// permission (it starts the dbt adapter), so it goes through the CLI.
//
// One check runs at a time. Changes that land while one runs are checked by the next, which starts
// when that one ends.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, PluginOptions, RenderElement, ToolCallResult } from 'claude-code'

import type { HealthInsight, HealthState } from '../../types'
import { later, runTool, within } from '../altimate-cli'
import { setStatusPart } from '../status-line'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { BandUi, FeatureContext } from './index'

export type { HealthInsight }
type HealthRun = { insights: HealthInsight[] } | { problem: string }

const COMMAND = 'health'
/** A check can take minutes: the dbt adapter starts, then DataPilot reads the manifest. */
const CHECK_MS = 9 * 60_000
/** How long /health waits for a running check before it answers with what it has. */
const COMMAND_WAIT_MS = 3_000
/** The most issues the push refusal and the report list. */
const LISTED = 10
const NEEDS_CLI = 'Project health needs an altimate-code build newer than 0.12.10 (one with the dbt_health tool)'
const ROOT_FILES = new Set(['dbt_project.yml', 'profiles.yml', 'packages.yml', 'dependencies.yml', 'selectors.yml'])
const SKIPPED_DIRS = /(?:^|\/)(?:target|dbt_packages|dbt_modules|node_modules|\.git|\.github|logs)\//

const healthAtom = atom({ plugin: 'altimate-code', key: 'health' } as const, null as HealthState | null)

const fresh = (): HealthState => ({ baseline: null, pending: [], touched: [], issues: [], problem: null, running: false })

let options: PluginOptions = {}
/** Bumped at each session start and end: a check that began before does not write its answer. */
let generation = 0
/** The check loop that is running, if any. */
let running: { generation: number; done: Promise<void> } | null = null
/** Whether this session checks at all: a dbt project was found, and somebody will see the answer or the push gate needs it. */
let enabled = false
/** Whether the session may check once it finds a dbt project (see `enabled`). */
let eligible = false
/** The problem told to the user last, so the same one is not told at every turn. */
let toldProblem: string | null = null
/** Whether the status line carries the health part now. */
let drawn = false
/** dbt project roots by folder, null for a folder in no project. */
const projects = new Map<string, string | null>()

export const pairKey = (i: Pick<HealthInsight, 'uniqueId' | 'name'>) => `${i.uniqueId}\u0000${i.name}`

const norm = (p: string) => p.replace(/\\/g, '/')

/** The models whose SQL file or properties file is one of `files`. */
export function modelsOfFiles(files: readonly string[], insights: readonly HealthInsight[]): Set<string> {
  const changed = new Set(files.map(norm))
  const ids = new Set<string>()
  for (const i of insights) if ((i.file && changed.has(norm(i.file))) || (i.properties && changed.has(norm(i.properties)))) ids.add(i.uniqueId)
  return ids
}

/** The insights the baseline lacks, on the given models. */
export function newIssues(insights: readonly HealthInsight[], baseline: readonly string[], models: ReadonlySet<string>): HealthInsight[] {
  const had = new Set(baseline)
  return insights.filter(i => models.has(i.uniqueId) && !had.has(pairKey(i)))
}

const shortName = (id: string) => id.split('.').pop() ?? id

/** "2 new health issues · stg_orders: hard coded references (+1 more model) · /health" */
export function bandText(issues: readonly HealthInsight[]): string {
  const first = issues[0]
  if (!first) return ''
  const more = new Set(issues.map(i => i.uniqueId)).size - 1
  return `${issues.length} new health issue${issues.length === 1 ? '' : 's'} · ${shortName(first.uniqueId)}: ${first.name.toLowerCase()}${more > 0 ? ` (+${more} more model${more === 1 ? '' : 's'})` : ''} · /${COMMAND}`
}

export function reportText(issues: readonly HealthInsight[]): string {
  const lines = issues.slice(0, LISTED).map(i => `- ${shortName(i.uniqueId)}: ${i.name.toLowerCase()} (${i.severity.toLowerCase()}) ${i.message}${i.recommendation ? ` → ${i.recommendation}` : ''}`)
  if (issues.length > LISTED) lines.push(`- and ${issues.length - LISTED} more`)
  return lines.join('\n')
}

const OPERATORS = new Set([';', '&', '|', '(', ')', '\n', '{', '}'])
/** Words that come before the command they apply to: `sudo git push`, `FOO=1 git push`, `! git push`. */
const LEADERS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'builtin', 'nice', 'doas', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])
/** The options of those words that take their value as the next word. */
const LEADER_VALUE_OPTIONS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S'],
  nice: ['-n'],
}
/** git's options that take their value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/** The simple commands of a shell line, each as its words with quotes removed; a quoted word stays one word. */
export function simpleCommands(line: string): string[][] {
  const commands: string[][] = []
  const nested: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      word += line.slice(i + 1, close < 0 ? line.length : close)
      inWord = true
      i = close < 0 ? line.length : close
    } else if (c === '"') {
      inWord = true
      i++
      for (; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '$' && line[i + 1] === '(') {
          // A substitution inside quotes still runs: its commands are commands of the line.
          let depth = 0
          let j = i + 1
          for (; j < line.length; j++) {
            if (line[j] === '(') depth++
            else if (line[j] === ')' && --depth === 0) break
          }
          nested.push(...simpleCommands(line.slice(i + 2, j)))
          word += line.slice(i, j + 1)
          i = j
          continue
        }
        if (line[i] === '\\' && i + 1 < line.length) i++
        word += line[i]
      }
    } else if (c === '\\' && line[i + 1] === '\n') {
      i++
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      inWord = true
    } else if (c === '$' && line[i + 1] === '(') {
      endCommand()
      i++
    } else if (c === '`' || OPERATORS.has(c)) {
      endCommand()
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return [...commands, ...nested]
}

/** Where the command itself starts in a simple command's words: past env assignments, `sudo -u x`, `nice -n 10`, and the like. */
function leaderEnd(words: readonly string[]): number {
  let i = 0
  let leader = ''
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_]\w*=/.test(w)) i++
    else if (LEADERS.has(w)) leader = words[i++]!
    else if (leader && w.startsWith('-')) i += LEADER_VALUE_OPTIONS[leader]?.includes(w) ? 2 : 1
    else break
  }
  return i
}

function pushes(words: readonly string[]): boolean {
  const start = leaderEnd(words)
  let i = start
  const bin = (words[i] ?? '').split('/').pop() ?? ''
  if (SHELLS.has(bin)) {
    const c = words.findIndex((w, j) => j > i && /^-[a-z]*c$/.test(w))
    return c >= 0 && c + 1 < words.length && isGitPush(words[c + 1]!)
  }
  if (bin !== 'git') return false
  for (i++; i < words.length && words[i]!.startsWith('-'); i++) if (GIT_VALUE_OPTIONS.has(words[i]!)) i++
  return words[i] === 'push'
}

/** Whether a Bash command line runs `git push`, in a pipeline, a list, a subshell or `bash -c`; not one that only names it in quotes. */
export function isGitPush(command: string): boolean {
  return simpleCommands(command).some(pushes)
}

const MODEL_FILE = /\.(sql|ya?ml)$/i
/** Commands that change the files they are given. */
const WRITERS = new Set(['mv', 'cp', 'rm', 'tee', 'patch', 'touch', 'truncate', 'install', 'ln'])
/** git subcommands that change files in the working tree. */
const GIT_WRITERS = new Set(['checkout', 'restore', 'apply', 'stash', 'reset', 'revert', 'merge', 'pull', 'rebase', 'cherry-pick', 'switch', 'mv', 'rm', 'am'])

/** The model-like file paths a Bash command line writes: redirects, `tee`, `sed -i`, `mv`, `git checkout -- file`. */
export function filesWrittenBy(command: string): string[] {
  const out: string[] = []
  for (const words of simpleCommands(command)) {
    const models = (list: readonly string[]) => list.filter(w => MODEL_FILE.test(w) && !w.startsWith('-'))
    for (let i = 0; i < words.length; i++) {
      const redirect = /^\d*>>?(.*)$/.exec(words[i]!)
      if (redirect) out.push(...models([redirect[1] || words[i + 1] || '']))
    }
    const at = leaderEnd(words)
    const bin = (words[at] ?? '').split('/').pop() ?? ''
    const args = words.slice(at + 1)
    if (WRITERS.has(bin)) out.push(...models(args))
    else if ((bin === 'sed' || bin === 'perl') && args.some(w => /^-[a-zA-Z]*i/.test(w) || w === '--in-place' || w.startsWith('--in-place='))) out.push(...models(args))
    else if (bin === 'git' && args.some(w => GIT_WRITERS.has(w))) out.push(...models(args))
  }
  return out
}

/** The `dbt_health` arguments for the plugin's `healthConfigPath` setting. */
export function toolArgs(configPath: unknown): Record<string, unknown> {
  const config = typeof configPath === 'string' ? configPath.trim() : ''
  return config ? { config_path: config } : {}
}

/** The dbt project folder above `dir` (up to 40 levels), cached; null when there is none. */
async function projectAbove($: EngineInterface, dir: string): Promise<string | null> {
  const seen: string[] = []
  let found: string | null = null
  let at = dir
  for (let i = 0; at && i < 40; i++) {
    if (projects.has(at)) {
      found = projects.get(at) ?? null
      break
    }
    seen.push(at)
    if (await $.fs.exists(`${at}/dbt_project.yml`).catch(() => false)) {
      found = at
      break
    }
    const parent = at.replace(/[\\/][^\\/]*$/, '')
    if (parent === at) break
    at = parent
  }
  for (const d of seen) projects.set(d, found)
  return found
}

/** Whether a changed file is one a model check can be about: a .sql or .yml in a dbt project, not dbt's own files. */
async function isModelFile($: EngineInterface, file: string): Promise<boolean> {
  const path = norm(file)
  if (!/\.(sql|ya?ml)$/i.test(path) || SKIPPED_DIRS.test(path) || ROOT_FILES.has(path.split('/').pop() ?? '')) return false
  return (await projectAbove($, path.replace(/\/[^/]*$/, ''))) !== null
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
  // A refusal or failure comes back as success false with an empty list: only success true is an answer.
  const insights = result.metadata?.insights
  if (result.ok && result.metadata?.success === true && Array.isArray(insights)) return { insights: insights as HealthInsight[] }
  if (/unknown tool/i.test(result.text)) return { problem: NEEDS_CLI }
  return { problem: `Project health: ${(result.text || 'no answer').split('\n')[0]}` }
}

async function drawStatus($: EngineInterface, issues: readonly HealthInsight[]) {
  const n = issues.length
  if (n === 0 && !drawn) return
  drawn = n > 0
  await setStatusPart($, 'health', n > 0 ? `${n} health issue${n === 1 ? '' : 's'}` : null)
}

/** Tells a problem once, until a different one comes. */
function tell($: EngineInterface, problem: string) {
  if (problem === toldProblem) return
  toldProblem = problem
  $.ui.toast(`◆ ${problem}`, { timeoutMs: 8000 })
}

/**
 * The checks the state asks for, one after another: the baseline when there is none, then the changed
 * models. Edits that land during a check leave `pending` set, which starts the next. A session
 * restart bumps `generation`, and an older loop stops without writing.
 */
async function loop($: EngineInterface, mine: number) {
  for (;;) {
    const before = await read($, healthAtom)
    if (mine !== generation || !before) return
    const needsBaseline = before.baseline === null
    if (!needsBaseline && before.pending.length === 0) return
    // The baseline run leaves `pending` alone: edits made while it ran are checked by the next run.
    const batch = needsBaseline ? [] : before.pending
    await update($, healthAtom, prev => ({ ...(prev ?? fresh()), pending: needsBaseline ? (prev?.pending ?? []) : (prev?.pending ?? []).filter(f => !batch.includes(f)), running: true }))
    const run = await check($)
    if (mine !== generation) return
    if ('problem' in run) {
      // The issues found so far stay until a check says otherwise, and the changes it did not cover are asked for again.
      await update($, healthAtom, prev => {
        const base = prev ?? fresh()
        return { ...base, running: false, problem: run.problem, pending: [...new Set([...batch, ...base.pending])] }
      })
      tell($, run.problem)
      // Not asked for again at once: the next change, /health or push asks.
      return
    }
    await update($, healthAtom, prev => {
      const base = prev ?? fresh()
      const baseline = base.baseline ?? run.insights.map(pairKey)
      const issues = newIssues(run.insights, baseline, modelsOfFiles(base.touched, run.insights))
      return { ...base, baseline, issues, running: false, problem: null }
    })
    toldProblem = null
    const issues = (await read($, healthAtom))?.issues ?? []
    await drawStatus($, issues)
    if (!needsBaseline && issues.length) $.ui.toast(`◆ ${bandText(issues)}`, { timeoutMs: 8000 })
  }
}

/** Starts the check loop unless one runs; resolves when the loop that is running ends. */
function kick($: EngineInterface): Promise<void> {
  if (running && running.generation === generation) return running.done
  const mine = generation
  const entry: { generation: number; done: Promise<void> } = {
    generation: mine,
    done: loop($, mine)
      .catch(error => {
        try {
          $.ui.log(`health check failed: ${String(error)}`, { to: 'debug' })
        } catch {}
      })
      .then(async () => {
        if (running === entry) running = null
        if (mine === generation) await update($, healthAtom, prev => (prev?.running ? { ...prev, running: false } : prev)).catch(() => {})
      }),
  }
  running = entry
  return entry.done
}

/**
 * Whether the state wants a check: changes not yet checked, or no baseline yet. After a failed check it is
 * asked for again only by a new change or by `retry` (the person asking with /health), not at every turn.
 */
async function wantsCheck($: EngineInterface, retry = false): Promise<boolean> {
  const state = await read($, healthAtom)
  if (!enabled || !state) return false
  return (retry || !state.problem) && (state.pending.length > 0 || state.baseline === null)
}

/** Adds this feature's own hooks. */
export function register(on: On, context: FeatureContext) {
  options = context.options
  on('command.run', { command: COMMAND }, async $ => {
    const state = await read($, healthAtom)
    if (!state || !enabled) return { text: 'Project health checks dbt projects: this session has none open yet.' }
    // Asking again retries a first check that failed, and checks changes not yet checked.
    if (await wantsCheck($, true)) {
      const done = kick($)
      await within($, COMMAND_WAIT_MS, done)
    }
    const now = await read($, healthAtom)
    if (!now) return { text: 'Project health is not set up in this session yet.' }
    if (now.problem) return { text: now.problem }
    if (now.baseline === null || now.running) return { text: 'Project health is still checking: ask again in a minute.' }
    return { text: now.issues.length ? `${bandText(now.issues)}\n${reportText(now.issues)}` : 'No new health issues in the models changed this session.' }
  })
}

export async function sessionStart($: EngineInterface, e: Args<'session.start'>) {
  generation += 1
  running = null
  enabled = false
  toldProblem = null
  projects.clear()
  await update($, healthAtom, () => fresh())
  if (drawn) await drawStatus($, [])
  await $.command.register({ name: COMMAND, description: 'Show the project health issues Claude introduced' })
  // The baseline takes a while (the dbt adapter starts): nothing waits for it. A session with nobody at
  // the prompt checks only when the push gate needs it.
  eligible = e.isInteractive || options.healthBlocksPush === true || options.healthBlocksPush === 'true'
  const root = await $.session.root().catch(() => '')
  if (!eligible || !root || !(await projectAbove($, root))) return
  enabled = true
  later($, () => kick($))
}

/** Also called for a subagent's turns, which carry `e.agentId`. */
export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

/** After the turn's answer: when model files changed, check again. */
export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {
  if ((e as { agentId?: string }).agentId) return
  if (await wantsCheck($)) later($, () => kick($))
}

export async function sessionEnd($: EngineInterface, e: Args<'session.end'>) {
  generation += 1
  running = null
  enabled = false
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

/**
 * With `healthBlocksPush` on, `git push` waits for the check of the changes so far and is refused while
 * they have new health issues. A check that cannot run does not hold the push: it is told once, and
 * /health shows it.
 */
export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  if (!(options.healthBlocksPush === true || options.healthBlocksPush === 'true') || !isGitPush(e.command)) return null
  if ((await wantsCheck($)) || running?.generation === generation) await within($, CHECK_MS, kick($))
  const state = await read($, healthAtom)
  return pushRefusal(options.healthBlocksPush, e.command, state?.issues ?? [])
}

/** A model file Bash writes (a `sed -i`, a redirect, a `git checkout -- file`) is checked like one Claude edited. */
export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {
  const root = await $.session.root().catch(() => '')
  for (const name of filesWrittenBy(e.command)) await markChanged($, name.startsWith('/') || /^[A-Za-z]:/.test(name) ? name : `${root}/${name}`)
}

async function markChanged($: EngineInterface, file: string) {
  const path = norm(file)
  if (!(await isModelFile($, path))) return
  // A session that opened outside a dbt project checks from its first change to one.
  if (eligible && !enabled) enabled = true
  await update($, healthAtom, prev => {
    const base = prev ?? fresh()
    return {
      ...base,
      // A new change asks for a check again after a failed one.
      problem: null,
      pending: base.pending.includes(path) ? base.pending : [...base.pending, path],
      touched: base.touched.includes(path) ? base.touched : [...base.touched, path],
    }
  })
}

/** A model file Claude changed is checked at the end of the turn. */
export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {
  const root = await $.session.root().catch(() => '')
  await markChanged($, file.path.startsWith('/') || /^[A-Za-z]:/.test(file.path) ? file.path : `${root}/${file.path}`)
}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
