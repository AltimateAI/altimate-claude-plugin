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
import { NOT_FOUND, later, runTool, within } from '../altimate-cli'
import { setStatusPart } from '../status-line'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { BandUi, FeatureContext } from './index'

export type { HealthInsight }
type HealthRun = { insights: HealthInsight[] } | { problem: string }

const COMMAND = 'health'
/** A check can take minutes: the dbt adapter starts, then DataPilot reads the manifest. */
const CHECK_MS = 9 * 60_000
/** How long the push gate waits for a check: inside the tool chain's phase deadline, past which a gate is given up on and the push runs. */
// The tool chain gives a phase 5 s; the push gate waits inside that. Kept here, not imported, to avoid an import cycle with the chain.
export const GATE_WAIT_MS = 4_000
/** How long /health waits for a running check before it answers with what it has. */
const COMMAND_WAIT_MS = 3_000
/** The most issues the push refusal and the report list. */
const LISTED = 10
const NEEDS_CLI = 'Project health needs an altimate-code release with the dbt_health tool: npm i -g @altimateai/altimate-code'
const NO_CLI = 'Project health needs the altimate-code CLI on your PATH: npm i -g @altimateai/altimate-code'
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
/** Which model each file belonged to in earlier checks: a deleted schema file or model no longer shows in the latest answer. */
let known: HealthInsight[] = []
/** Whether the status line carries the health part now. */
let drawn = false
/** dbt project roots by folder, null for a folder in no project. */
const projects = new Map<string, string | null>()

export const pairKey = (i: Pick<HealthInsight, 'uniqueId' | 'name'>) => `${i.uniqueId}\u0000${i.name}`

/** A path with `/` separators and no `.`, `..` or empty parts, so two spellings of one file compare equal. */
const norm = (p: string) => {
  const absolute = p.startsWith('/') || p.startsWith('\\')
  const parts: string[] = []
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..' && !/^[A-Za-z]:$/.test(parts[parts.length - 1]!)) parts.pop()
    else if (part !== '..' || !absolute) parts.push(part)
  }
  return (absolute ? '/' : '') + parts.join('/')
}

/** A path as the system names it: how `canonical` spells it, or `norm`'s spelling for a path it was not asked about. */
export type RealPath = (path: string) => string

/** The folder's real path; a folder that does not exist gets its nearest existing folder's real path and the rest. */
async function realFolder($: EngineInterface, dir: string, seen: Map<string, Promise<string>>): Promise<string> {
  const known = seen.get(dir)
  if (known) return known
  const work = (async () => {
    const stat = await $.fs.stat(dir, { resolve: true }).catch(() => null)
    if (stat?.realPath) return norm(stat.realPath)
    // A deleted or renamed file's folder may be gone too: resolve the nearest folder that exists and keep the rest.
    const slash = dir.lastIndexOf('/')
    if (slash <= 0) return dir
    return `${await realFolder($, dir.slice(0, slash), seen)}${dir.slice(slash)}`
  })()
  seen.set(dir, work)
  return work
}

/**
 * Resolves each file's folder through the engine (a symlinked folder to the one `dbt_health` names a model's files under),
 * so the hooks module needs no file-system module of its own. The result is for the files asked about.
 */
export async function canonical($: EngineInterface, files: readonly string[]): Promise<RealPath> {
  const seen = new Map<string, Promise<string>>()
  const real = new Map<string, string>()
  await Promise.all(
    [...new Set(files.filter(Boolean).map(norm))].map(async file => {
      const slash = file.lastIndexOf('/')
      real.set(file, slash <= 0 ? file : `${await realFolder($, file.slice(0, slash), seen)}${file.slice(slash)}`)
    }),
  )
  return p => {
    const n = norm(p)
    return real.get(n) ?? n
  }
}

/** The models whose SQL file or properties file is one of `files`; `real` names the paths as `canonical` resolved them. */
export function modelsOfFiles(files: readonly string[], insights: readonly HealthInsight[], real: RealPath = norm): Set<string> {
  const changed = new Set(files.map(real))
  const ids = new Set<string>()
  for (const i of insights) if ((i.file && changed.has(real(i.file))) || (i.properties && changed.has(real(i.properties)))) ids.add(i.uniqueId)
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

/** Where the heredoc started by `<<` at `i` ends: its delimiter, whether it was quoted, and `<<` at `i` is one at all (not `<<<`, not a shift in `$((x<<2))`). */
function heredocAt(text: string, i: number): { delimiter: string; quoted: boolean; strip: boolean; end: number } | null {
  if (text[i] !== '<' || text[i + 1] !== '<' || text[i + 2] === '<' || text[i - 1] === '<') return null
  let j = i + 2
  const strip = text[j] === '-'
  if (strip) j++
  while (text[j] === ' ' || text[j] === '\t') j++
  let delimiter = ''
  let quoted = false
  for (; j < text.length && !/[\s;&|()<>]/.test(text[j]!); j++) {
    if (text[j] === "'" || text[j] === '"') {
      quoted = true
      const close = text.indexOf(text[j]!, j + 1)
      delimiter += text.slice(j + 1, close < 0 ? text.length : close)
      j = close < 0 ? text.length : close
    } else if (text[j] === '\\') {
      quoted = true
      delimiter += text[++j] ?? ''
    } else delimiter += text[j]
  }
  // A `<<` with no closing line after it is a shift (`$((a<<b))`), not a heredoc.
  if (!delimiter) return null
  const closes = (line: string) => (strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === delimiter
  const eol = text.indexOf('\n', j)
  if (eol < 0 || !text.slice(eol + 1).split('\n').some(closes)) return null
  return { delimiter, quoted, strip, end: j - 1 }
}

/** The body of a heredoc whose line ends at `eol`: its text, and where the line after its delimiter line starts. */
function heredocBody(text: string, eol: number, doc: { delimiter: string; strip: boolean }): { body: string; next: number } {
  let at = eol + 1
  let body = ''
  while (at < text.length) {
    const end = text.indexOf('\n', at)
    const line = text.slice(at, end < 0 ? text.length : end)
    at = end < 0 ? text.length : end + 1
    if ((doc.strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === doc.delimiter) break
    body += line + '\n'
  }
  return { body, next: at }
}

/** The index of the `)` that closes the `$(` at `open`, skipping quotes and heredoc bodies; text.length when it never closes. */
function substitutionEnd(text: string, open: number): number {
  let depth = 1
  const pending: { delimiter: string; strip: boolean }[] = []
  for (let j = open + 1; j < text.length; j++) {
    const c = text[j]!
    if (c === '\\') j++
    else if (c === "'") {
      const close = text.indexOf("'", j + 1)
      j = close < 0 ? text.length : close
    } else if (c === '"') {
      for (j++; j < text.length && text[j] !== '"'; j++) if (text[j] === '\\') j++
    } else if (c === '<') {
      const doc = heredocAt(text, j)
      if (doc) {
        pending.push(doc)
        j = doc.end
      }
    } else if (c === '\n' && pending.length) {
      for (const doc of pending.splice(0)) j = heredocBody(text, j, doc).next - 1
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  return text.length
}

/** The inner text of each `$(...)` and backtick substitution in `text`. */
function substitutionsIn(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '$' && text[i + 1] === '(') {
      const j = substitutionEnd(text, i + 1)
      out.push(text.slice(i + 2, j))
      i = j
    } else if (text[i] === '`') {
      const close = text.indexOf('`', i + 1)
      out.push(text.slice(i + 1, close < 0 ? text.length : close))
      i = close < 0 ? text.length : close
    }
  }
  return out
}

/** The simple commands of a shell line, each as its words with quotes removed; a quoted word stays one word. A redirect is its own word (`>`, `>>`, `2>`) before its target; a heredoc body is text, not commands, unless a shell reads it as its script or an unquoted body substitutes commands. */
export function simpleCommands(line: string): string[][] {
  const commands: string[][] = []
  const nested: string[][] = []
  const heredocs: { delimiter: string; quoted: boolean; strip: boolean; owner: string[] }[] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  // Whether the word being read has quoted or escaped text: digits then are an argument, not a file descriptor.
  let quoted = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
    quoted = false
  }
  const bareDescriptor = () => inWord && !quoted && /^\d+$/.test(word)
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '#' && !inWord && !(line[i - 1] === '{' && line[i - 2] === '$')) {
      // An unquoted `#` at the start of a word is a comment to the end of the line: its quotes and commands are text.
      // The `#` of `${#name}` (a length) is not one: `{` ends the word before it.
      const end = line.indexOf('\n', i)
      i = end < 0 ? line.length : end - 1
    } else if (c === "'") {
      quoted = true
      const close = line.indexOf("'", i + 1)
      word += line.slice(i + 1, close < 0 ? line.length : close)
      inWord = true
      i = close < 0 ? line.length : close
    } else if (c === '"') {
      inWord = true
      quoted = true
      i++
      for (; i < line.length && line[i] !== '"'; i++) {
        if ((line[i] === '$' && line[i + 1] === '(') || line[i] === '`') {
          // A substitution inside quotes still runs: its commands are commands of the line.
          let j = i
          if (line[i] === '`') {
            j = line.indexOf('`', i + 1)
            if (j < 0) j = line.length
          } else j = substitutionEnd(line, i + 1)
          nested.push(...substitutionsIn(line.slice(i, j + 1)).flatMap(simpleCommands))
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
      quoted = true
    } else if (c === '$' && line[i + 1] === '(') {
      endCommand()
      i++
    } else if (c === '<' && heredocAt(line, i)) {
      const doc = heredocAt(line, i)!
      // The command the heredoc feeds: the one being read now, which `words` goes on to hold.
      heredocs.push({ ...doc, owner: words })
      i = doc.end
    } else if (c === '\n' && heredocs.length) {
      endCommand()
      let at = i
      // A heredoc fed to a shell is that shell's script; an unquoted body's substitutions run either way.
      for (const doc of heredocs.splice(0)) {
        const { body, next } = heredocBody(line, at, doc)
        at = next - 1
        const bin = (doc.owner[leaderEnd(doc.owner)] ?? '').split('/').pop() ?? ''
        if (SHELLS.has(bin) && !doc.owner.some(w => /^-[a-z]*c$/.test(w))) nested.push(...simpleCommands(body))
        else if (!doc.quoted) nested.push(...substitutionsIn(body).flatMap(simpleCommands))
      }
      i = at
    } else if (c === '<' && line[i + 1] !== '(') {
      // An input redirect (`<`, `<<<`) is its own word before its target, as an output one is.
      if (!bareDescriptor()) endWord()
      word += '<'
      if (line.startsWith('<<', i + 1)) {
        word += '<<'
        i += 2
      } else if (line[i + 1] === '>') word += line[++i]
      inWord = true
      endWord()
    } else if (c === '>') {
      if (!bareDescriptor()) endWord()
      word += '>'
      if (line[i + 1] === '>' || line[i + 1] === '&' || line[i + 1] === '|') word += line[++i]
      inWord = true
      endWord()
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
    else if (/^\d*(>[>|&]?|<(<<|>)?)$/.test(w)) i += 2
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

/** The model-like file paths a Bash command line writes: redirects, `tee`, `sed -i`, `mv`, `git checkout -- file`; a relative path is given from the folder a `cd` before it moved to. */
export function filesWrittenBy(command: string): string[] {
  const out: string[] = []
  let cwd = ''
  const from = (w: string) => (w.startsWith('/') || /^[A-Za-z]:/.test(w) || !cwd ? w : `${cwd}/${w}`)
  for (const all of simpleCommands(command)) {
    // An input redirect's operand is read, not written.
    const words = all.filter((_, j) => !/^\d*<(<<|>)?$/.test(all[j - 1] ?? '') && !/^\d*<(<<|>)?$/.test(all[j]!))
    const models = (list: readonly string[]) => list.filter(w => MODEL_FILE.test(w) && !w.startsWith('-')).map(from)
    for (let i = 0; i < words.length; i++) {
      const redirect = /^\d*>[>|]?$/.exec(words[i]!)
      if (redirect) out.push(...models([words[i + 1] ?? '']))
    }
    const at = leaderEnd(words)
    const bin = (words[at] ?? '').split('/').pop() ?? ''
    const args = words.slice(at + 1)
    if (bin === 'cd') cwd = args[0] && !args[0].startsWith('-') && !args[0].startsWith('~') ? from(args[0]) : ''
    else if (SHELLS.has(bin)) {
      const c = args.findIndex(w => /^-[a-z]*c$/.test(w))
      if (c >= 0 && c + 1 < args.length) out.push(...filesWrittenBy(args[c + 1]!).map(from))
    } else if (WRITERS.has(bin)) out.push(...models(args))
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

/** Why a `healthConfigPath` setting can't be used: it must stay inside the dbt project. Null when it can. */
export function configPathProblem(configPath: unknown): string | null {
  const config = typeof configPath === 'string' ? configPath.trim() : ''
  if (!config) return null
  if (/^([\\/]|[A-Za-z]:)/.test(config) || config.split(/[\\/]/).includes('..'))
    return 'Project health: the "Project health check config" setting must be a path inside the dbt project (relative, without ..).'
  return null
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
  if (!/\.(sql|ya?ml)$/i.test(path)) return false
  const dir = path.replace(/\/[^/]*$/, '')
  const project = await projectAbove($, dir)
  // dbt's own folders are skipped by their place in the project, not by where the project sits on disk.
  const inside = project !== null && path.startsWith(`${norm(project)}/`) ? path.slice(norm(project).length + 1) : path
  if (SKIPPED_DIRS.test(inside)) return false
  // An installed package carries its own dbt_project.yml: judge its place under the project that installed it.
  if (project !== null) {
    const outer = await projectAbove($, norm(project).replace(/\/[^/]*$/, ''))
    if (outer !== null && norm(outer) !== norm(project) && path.startsWith(`${norm(outer)}/`) && SKIPPED_DIRS.test(path.slice(norm(outer).length + 1))) return false
  }
  // dbt's own files are the ones at the project root; a `profiles.yml` in a model folder is a properties file.
  return project !== null && !(ROOT_FILES.has(path.split('/').pop() ?? '') && norm(project) === dir)
}

/** Asks altimate-code's dbt_health for the project's insights. */
async function check($: EngineInterface): Promise<HealthRun> {
  const badConfig = configPathProblem(options.healthConfigPath)
  if (badConfig) return { problem: badConfig }
  let result: Awaited<ReturnType<typeof runTool>>
  try {
    const until = (await $.clock.now()) + CHECK_MS
    result = await runTool($, 'dbt_health', toolArgs(options.healthConfigPath), { write: true, until })
  } catch (error) {
    // Only a binary that is not there: one that is there and refused to start keeps its own words.
    if (NOT_FOUND.test(String(error))) return { problem: NO_CLI }
    return { problem: `Project health could not run: ${String(error).split('\n')[0]}` }
  }
  // A refusal or failure comes back as success false with an empty list: only success true is an answer.
  const insights = result.metadata?.insights
  if (result.ok && result.metadata?.success === true && Array.isArray(insights)) {
    // Insights read from the last good manifest are not a check of the changes just made.
    const stale = result.metadata?.stale_manifest as { message?: unknown } | undefined
    // A result cut at the engine's size limit leaves the changed models' issues unknown: that is no check.
    if (result.metadata?.truncated === true) return { problem: 'Project health: the project has too many health insights for one check to read, so the changes could not be checked.' }
    if (stale) return { problem: `Project health: ${typeof stale.message === 'string' ? stale.message : 'dbt could not parse the project, so the last good manifest was read.'}` }
    return { insights: insights as HealthInsight[] }
  }
  if (/unknown tool/i.test(result.text)) return { problem: NEEDS_CLI }
  return { problem: `Project health: ${(result.text || 'no answer').split('\n')[0]}` }
}

async function drawStatus($: EngineInterface, issues: readonly HealthInsight[]) {
  const n = issues.length
  if (n === 0 && !drawn) return
  drawn = n > 0
  await setStatusPart($, 'health', n > 0 ? `${n} health issue${n === 1 ? '' : 's'}` : null)
}

/**
 * Tells a problem once, until a different one comes. A missing altimate-code, or one without the tool, is not
 * told: the checks run by themselves (session start, each turn), so only /health, which asks for the answer,
 * says it (the status line names a missing or old altimate-code, though not a missing tool).
 */
function tell($: EngineInterface, problem: string) {
  if (problem === toldProblem || problem === NEEDS_CLI || problem === NO_CLI) return
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
    // Resolving the folders takes engine calls, and an edit can land meanwhile: the result is committed only with
    // every touched file resolved, so a late edit's model never counts its old issues as the baseline.
    // After three tries the answer is not committed (it would count a late edit's model in its unresolved
    // spelling): the changes it covered are asked for again, and the loop starts over.
    let again = false
    for (let attempt = 0; ; attempt++) {
      const asked = new Set((await read($, healthAtom))?.touched ?? [])
      const seen = [...known, ...run.insights]
      const real = await canonical($, [...asked, ...seen.flatMap(i => [i.file, i.properties])])
      // A session that restarted meanwhile owns the state now: this check's answer is for the one before.
      if (mine !== generation) return
      let late = false
      await update($, healthAtom, prev => {
        const base = prev ?? fresh()
        if (mine !== generation) return base
        if (base.touched.some(f => !asked.has(f))) {
          late = true
          if (attempt < 3) return base
          again = true
          return { ...base, pending: [...new Set([...batch, ...base.pending])] }
        }
        // A baseline that lands after edits (the first run failed, or the project was opened above the dbt
        // project) cannot tell the touched models' old issues from the new: all of theirs count as new.
        const edited = modelsOfFiles(base.touched, seen, real)
        // A schema file the latest answer no longer names was deleted (or never mattered): its models, the ones
        // that had no insight before included, are not found by their files, and new issues are told from the
        // baseline, so every model counts.
        const matched = new Set(run.insights.flatMap(i => [i.file, i.properties]).filter(Boolean).map(real))
        // Not when there is no baseline yet: counting every model as edited would make the baseline empty, and every existing issue new.
        if (base.baseline !== null && base.touched.some(f => /\.ya?ml$/i.test(f) && !matched.has(real(f)))) for (const i of run.insights) edited.add(i.uniqueId)
        // A model dropped from a schema file that still documents others shows its new issues with no properties file: they are not found by that file either.
        if (base.baseline !== null && base.touched.some(f => /\.ya?ml$/i.test(f))) for (const i of run.insights) if (!i.properties && i.file) edited.add(i.uniqueId)
        const baseline = base.baseline ?? run.insights.filter(i => !edited.has(i.uniqueId)).map(pairKey)
        const issues = newIssues(run.insights, baseline, edited)
        return { ...base, baseline, issues, running: false, problem: null }
      })
      if (!late || again) break
    }
    if (again) continue
    if (mine !== generation) return
    const keep = new Set(known.map(i => `${i.uniqueId}\0${i.file}\0${i.properties}`))
    for (const i of run.insights) if (!keep.has(`${i.uniqueId}\0${i.file}\0${i.properties}`)) known.push({ ...i, name: '', message: '', recommendation: '', severity: '' })
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
 * asked for again only by a new change or by `retry` (/health, or a `git push` held by the gate), not at every turn.
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
  known = []
  shellBefore.clear()
  projects.clear()
  await update($, healthAtom, () => fresh())
  // The status line outlives a process: a part an earlier one left is cleared whether or not this one drew it.
  drawn = true
  await drawStatus($, [])
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
    deny: `git push is held: the models changed this session have ${issues.length} new project health issue${issues.length === 1 ? '' : 's'}.\n${reportText(issues)}\nTell the user about them and stop; only the user can turn off "Project health blocks git push" in the plugin's settings.`,
  }
}

/**
 * With `healthBlocksPush` on, `git push` waits for the check of the changes so far and is refused while
 * they have new health issues. A check that cannot run or does not finish holds it too.
 */
export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  // A session outside a dbt project has no check to wait for and no folder to note.
  if (!enabled) return null
  if (!(options.healthBlocksPush === true || options.healthBlocksPush === 'true') || !isGitPush(e.command)) {
    // Where the shell is before this command runs: its own `cd`s are read from there, and `bashAfter` sees the folder after them.
    if (CHANGES_FOLDER.test(e.command)) noteFolder(e, await within($, GATE_WAIT_MS, shellFolder($)))
    return null
  }
  // The whole decision, folder lookups included, is bounded inside the chain's deadline: past it the gate is given up on and the push runs.
  const decided = await within($, GATE_WAIT_MS, decide($, e))
  return decided === null ? hold('the check of the changes could not be read in time.') : decided === 'run' ? null : decided
}

const hold = (why: string) => ({
  deny: `git push is held: ${why}\nRun /${COMMAND} to check again; only the user can turn off "Project health blocks git push" in the plugin's settings.`,
})

async function decide($: EngineInterface, e: BashCall): Promise<{ deny: string } | 'run'> {
  const startedAt = await $.clock.now()
  // An edit in the same command would run before any check of it.
  const here = await shellFolder($)
  if (CHANGES_FOLDER.test(e.command)) noteFolder(e, here)
  for (const name of filesWrittenBy(e.command)) if (await isModelFile($, name.startsWith('/') || /^[A-Za-z]:/.test(name) ? name : `${here}/${name}`)) return hold(`this command changes the model file ${name} and pushes in one go, so the change is not checked first. Run them as separate commands.`)
  // With nothing changed this session there is nothing to wait for or hold.
  if (((await read($, healthAtom))?.touched.length ?? 0) === 0) return 'run'
  // The wait is what is left of the gate's budget: the work above counts against the chain's deadline too.
  if ((await wantsCheck($, true)) || running?.generation === generation) {
    const left = GATE_WAIT_MS - ((await $.clock.now()) - startedAt)
    if (left > 0) await within($, left, kick($))
  }
  const state = await read($, healthAtom)
  // A check that failed or did not finish leaves the changes unchecked: a gate that fails open is no gate.
  if (state && enabled && (state.running || state.pending.length > 0 || state.baseline === null))
    return hold(`the check of the models changed this session ${state.running ? 'did not finish in time' : `could not run (${state.problem ?? 'no answer'})`}.`)
  return pushRefusal(options.healthBlocksPush, e.command, state?.issues ?? []) ?? 'run'
}

// The folder noted before each command with its own `cd` ran, by call (by command when the call has no id); `folder` is null when the lookup ran out of time.
// Calls can overlap (a subagent's), so one slot would lose a start folder.
const shellBefore = new Map<string, string | null>()
const callKey = (e: BashCall) => e.tool_use_id ?? e.command
function noteFolder(e: BashCall, folder: string | null) {
  shellBefore.delete(callKey(e))
  shellBefore.set(callKey(e), folder)
  // A call a later gate refused never reaches its after-phase: only the newest notes are kept.
  for (const old of [...shellBefore.keys()].slice(0, -50)) shellBefore.delete(old)
}
const CHANGES_FOLDER = /\b(cd|pushd)\b/

/** The folder the session's shell is in now; the session's root when the host does not say. */
async function shellFolder($: EngineInterface): Promise<string> {
  return (await $.session.cwd().catch(() => null)) || (await $.session.root().catch(() => ''))
}

/** A model file Bash writes (a `sed -i`, a redirect, a `git checkout -- file`) is checked like one Claude edited. */
export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {
  if (!enabled) return
  const root = await $.session.root().catch(() => '')
  // A relative name is relative to the folder the session's shell is in now: an earlier `cd` moved it.
  // A command with its own `cd` is read from the folder it started in, which the gate noted.
  // A note belongs to its own command; a command with a `cd` whose start is unknown is read from the session's root, where it began.
  const noted = shellBefore.has(callKey(e))
  const folder = shellBefore.get(callKey(e)) ?? null
  shellBefore.delete(callKey(e))
  const here = noted ? (folder ?? root) : CHANGES_FOLDER.test(e.command) ? root : await shellFolder($)
  for (const name of filesWrittenBy(e.command)) await markChanged($, name.startsWith('/') || /^[A-Za-z]:/.test(name) ? name : `${here}/${name}`, root)
}

async function markChanged($: EngineInterface, file: string, root: string) {
  const path = norm(file)
  if (!(await isModelFile($, path))) return
  // The CLI finds its project from the session's folder: a model of another project (a nested one, or one beside
  // the session's) is not covered by its check, so it is not counted as checked.
  const own = root ? await projectAbove($, norm(root)) : null
  const mine = await projectAbove($, path.replace(/\/[^/]*$/, ''))
  if (own === null || mine === null) return
  // Compared as the system names the folders, the way `canonical` matches an edit to an insight's file.
  const real = await canonical($, [`${own}/x`, `${mine}/x`])
  if (real(`${own}/x`) !== real(`${mine}/x`)) return
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
  await markChanged($, file.path.startsWith('/') || /^[A-Za-z]:/.test(file.path) ? file.path : `${root}/${file.path}`, root)
}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

/** Whether `editAfter` needs the file's text from before the edit (one extra read per edit). */
export const editReadsBefore = false
