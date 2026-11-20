// `/altimate-code:feedback <what happened>`: drafts a GitHub issue for this plugin's repository from the
// person's words plus a few facts the plugin already knows, shows the exact title and body, and creates the
// issue only after the person confirms with `--confirm`. Nothing is sent, and no `gh` or browser call is
// made, before that: the draft lives in memory until it is confirmed, discarded, replaced or the session ends.
//
// What is attached: plugin version, altimate-code version and binary name (never its path), Claude Code
// version, OS, dbt-core / adapter / Python versions when the dbt doctor has run, and the plugin's own
// on/off settings. The last plugin error is attached only when asked for with `--with-error`; it is
// redacted first (the dbt profile's secret values, tokens, home-directory and other absolute paths, lines
// that look like SQL, relation and node names). No paths, SQL, project, model or column names are collected.
import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { MISSING_BINARY, parseVersion } from './altimate-cli'
import { redactValues, scrubDbt, withoutValueFragment } from './dbt-mods-core'
import { dbtModsDoctorFacts } from './dbt-mods'
import { MAX_RAW_PROBLEM, asVersion, forgetProblem, problemNoted, type DoctorFacts } from './last-problem'
import { pluginVersion } from './usage'

export const REPO = 'AltimateAI/altimate-claude-plugin'
export const COMMAND = 'feedback'
export const LABEL = 'feedback'
/** The issue link is kept under this many characters: GitHub refuses a longer one. */
export const MAX_URL = 7000
export const MAX_DESCRIPTION = 4000
export const MAX_TITLE = 80
export const MAX_PROBLEM_CHARS = 600
export const MAX_PROBLEM_LINES = 6
const DRY_RUN_ENV = 'ALTIMATE_FEEDBACK_DRY_RUN'
const CLI_NAMES = ['altimate', 'altimate-code'] as const
const CONFIRM = '--confirm'
const CANCEL = '--cancel'
const WITH_ERROR = '--with-error'
const TRUNCATION_NOTE = '\n\n[Cut to fit the link: the full text was shown before it was opened.]'
/** The plugin settings that are shown: an allow-list, so a setting that holds a path or a name is never read. */
const SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['dbt_mods', 'dbt helpers'],
  ['healthBlocksPush', 'project health blocks git push'],
  ['commentsInContext', 'team comments in context'],
  ['show_edit_impact', 'edit impact notes'],
]

// ─── Redaction ────────────────────────────────────────────────────────────────────────────────────────

const MASK = '‹redacted›'
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`],
  // user:password@host in a connection string or URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, `$1${MASK}@`],
  [/\b((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
  // A long unbroken run of key-like characters.
  [/\b(?=[A-Za-z0-9_+-]*\d)[A-Za-z0-9_+-]{40,}={0,2}/g, MASK],
]

/** The text with every token, key, password and connection-string credential cut out. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, to]) => out.replace(pattern, to), redactValues(text))
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The home folder forms to look for, from the values of HOME and USERPROFILE. */
function homeForms(homes: readonly string[]): string[] {
  const forms = new Set<string>()
  for (const home of homes) {
    const trimmed = home.replace(/[\\/]+$/, '')
    // A root (`/`) or a one-segment value would match everything.
    if (trimmed.length < 3) continue
    forms.add(trimmed)
    forms.add(trimmed.replace(/\\/g, '/'))
    forms.add(trimmed.replace(/\//g, '\\'))
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

/** Every path under the home folder, however long, replaced whole. */
export function withoutHome(text: string, homes: readonly string[]): string {
  return homeForms(homes).reduce((out, form) => out.replace(new RegExp(`${escapeRegex(form)}(?:[\\\\/][^\\s'"\`<>()]*)?`, 'gi'), '<path under home>'), text)
}

/** Every absolute path of two or more parts (a POSIX path, `~/…`, or a drive path), replaced whole. */
export function withoutPaths(text: string): string {
  return text
    .replace(/(?<![\w:/.~-])~\/[^\s'"`<>()]+/g, '<path>')
    .replace(/(?<![\w:/.~-])\/[^\s'"`<>()/]+\/[^\s'"`<>()]*/g, '<path>')
    .replace(/\b[A-Za-z]:\\[^\s'"`<>()]+/g, '<path>')
}

const SQL_LINE = /\b(?:select\b[^\n]*\bfrom\b|insert\s+into|delete\s+from|create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:table|view)|merge\s+into|update\s+\S+\s+set|alter\s+table|drop\s+(?:table|view))\b|^\s*(?:select|with|from|where|join|(?:left|right|inner|outer|cross|full)\s+join|group\s+by|order\s+by|having|union|limit\s+\d+|on)\b\s*\S/i

/** A line that reads as SQL is replaced by a fixed line; a dbt or warehouse error often quotes the statement. */
export function withoutSql(text: string): string {
  return text
    .split('\n')
    .map(line => (SQL_LINE.test(line) ? '<SQL omitted>' : line))
    .join('\n')
}

/** Quoted or three-part relation names (`db.schema.table`, `"RAW"."ORDERS"`) and the names given. */
function withoutNames(text: string, names: readonly string[]): string {
  let out = text
  for (const name of [...names].filter(one => one.length >= 2).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w])${escapeRegex(name)}(?![\\w])`, 'g'), '<name>')
  }
  return out
    .replace(/(["'`])[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*){1,2}\1/g, '<identifier>')
    .replace(/(?:"[\w$ -]+"|`[\w$ -]+`)(?:\.(?:"[\w$ -]+"|`[\w$ -]+`)){1,2}/g, '<identifier>')
    .replace(/\b[A-Za-z_][\w$]*\.[A-Za-z_][\w$]*\.[A-Za-z_][\w$]*\b/g, '<identifier>')
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const plain = (text: string) => text.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(LONE_SURROGATE, '')

/** What the person typed, as it will be filed: secrets and home-folder paths out, cut to length. Their own words are otherwise kept. */
export function cleanDescription(text: string, homes: readonly string[]): string {
  const cut = Array.from(plain(text).trim()).slice(0, MAX_DESCRIPTION).join('')
  return withoutHome(redactSecrets(withoutValueFragment(cut)), homes)
}

/** A plugin error as it may be filed: nothing the plugin has not redacted or reduced, in at most a few short lines. */
export function cleanProblem(raw: string, homes: readonly string[], names: readonly string[] = []): string {
  const capped = withoutValueFragment(plain(raw).slice(0, MAX_RAW_PROBLEM))
  const clean = withoutNames(withoutPaths(withoutSql(withoutHome(redactSecrets(scrubDbt(capped)), homes))), names)
  const lines = clean
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, MAX_PROBLEM_LINES)
  const joined = Array.from(lines.join('\n')).slice(0, MAX_PROBLEM_CHARS).join('')
  // The text sits in a code fence: nothing in it may close the fence.
  return joined.replace(/`{3,}/g, "'''")
}

// ─── The facts ────────────────────────────────────────────────────────────────────────────────────────

export type Facts = {
  plugin: string
  altimate: { name: string; version: string } | null
  claudeCode: string
  os: string
  doctor: DoctorFacts
  settings: Array<[string, boolean]>
  problem: { source: string; text: string } | null
}

export type Draft = { title: string; body: string; withProblem: boolean }

const OS = new Set(['macos', 'linux', 'windows', 'wsl'])


async function homesOf($: EngineInterface): Promise<string[]> {
  const [home, profile] = await Promise.all([$.env.get('HOME').catch(() => undefined), $.env.get('USERPROFILE').catch(() => undefined)])
  return [home, profile].filter((one): one is string => typeof one === 'string' && one !== '')
}

/** The altimate-code on PATH: the binary name that answered (`altimate` or `altimate-code`) and its version; never where it lives. */
async function altimateFacts($: EngineInterface): Promise<Facts['altimate']> {
  for (const name of CLI_NAMES) {
    try {
      const answer = await $.process.run([name, '--version'], { timeoutMs: 10_000 })
      const version = answer.exitCode === 0 ? (parseVersion(answer.stdout ?? '') ?? parseVersion(answer.stderr ?? '')) : null
      return version ? { name, version } : null
    } catch (error) {
      if (!MISSING_BINARY.test(String(error))) return null
    }
  }
  return null
}

export type Ask = { withProblem: boolean }

/** Gathers the facts. A fact that cannot be read is left out or `unknown`, never an error. */
export async function collectFacts($: EngineInterface, ask: Ask, extra: { doctor: DoctorFacts; settings: PluginOptions }): Promise<Facts> {
  const [plugin, altimate, claudeCode, os, homes] = await Promise.all([
    pluginVersion($).catch(() => 'unknown'),
    altimateFacts($).catch(() => null),
    $.session
      .version()
      .then(one => asVersion(one.version) ?? one.version.match(/^\d+(?:\.\d+){0,3}(?:-[\w.]+)?/)?.[0] ?? 'unknown')
      .catch(() => 'unknown'),
    $.session
      .info()
      .then(info => (OS.has(info.platform) ? info.platform : 'unknown'))
      .catch(() => 'unknown'),
    homesOf($),
  ])
  const settings: Array<[string, boolean]> = []
  for (const [key, label] of SETTINGS) {
    const value = extra.settings[key]
    if (typeof value === 'boolean') settings.push([label, value])
  }
  const noted = problemNoted()
  const problem = ask.withProblem && noted ? { source: noted.source, text: cleanProblem(noted.raw, homes, noted.names) } : null
  return { plugin, altimate, claudeCode, os, doctor: extra.doctor, settings, problem: problem && problem.text ? problem : null }
}

// ─── The draft ────────────────────────────────────────────────────────────────────────────────────────

/** The first line of the description, as the issue title. */
export function titleOf(description: string): string {
  const first = description.split('\n').find(line => line.trim()) ?? ''
  const oneLine = first.replace(/\s+/g, ' ').trim()
  const chars = Array.from(oneLine)
  return `Feedback: ${chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join('')}…` : oneLine}`
}

/** The issue: the person's words, then the facts, then (when asked for) the last plugin error. */
export function buildDraft(facts: Facts, description: string): Draft {
  const lines = [
    description,
    '',
    '---',
    '',
    '**Environment** (added by `/altimate-code:feedback`; nothing else is attached)',
    '',
    `- Plugin: altimate-code ${facts.plugin}`,
    `- altimate-code: ${facts.altimate ? `${facts.altimate.name} ${facts.altimate.version}` : 'not found on PATH'}`,
    `- Claude Code: ${facts.claudeCode}`,
    `- OS: ${facts.os}`,
  ]
  if (facts.doctor) {
    const parts = [facts.doctor.dbtCore && `dbt-core ${facts.doctor.dbtCore}`, facts.doctor.adapter && `adapter ${facts.doctor.adapter}`, facts.doctor.python && `Python ${facts.doctor.python}`].filter(Boolean)
    lines.push(`- dbt: ${parts.join(', ')}`)
  } else lines.push('- dbt: not checked this session')
  if (facts.settings.length) lines.push(`- Settings: ${facts.settings.map(([label, on]) => `${label} ${on ? 'on' : 'off'}`).join(', ')}`)
  if (facts.problem) lines.push('', `**Last plugin error** (${facts.problem.source}; redacted)`, '', '```text', facts.problem.text, '```')
  return { title: titleOf(description), body: lines.join('\n'), withProblem: !!facts.problem }
}

/** The prefilled new-issue link. A body too long for the link is cut, on a character boundary, and says so. */
export function issueUrl(draft: Pick<Draft, 'title' | 'body'>, max = MAX_URL): { url: string; truncated: boolean } {
  const make = (body: string) => `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(draft.title)}&body=${encodeURIComponent(body)}`
  const whole = make(draft.body)
  if (whole.length <= max) return { url: whole, truncated: false }
  const chars = Array.from(draft.body)
  let low = 0
  let high = chars.length
  // The longest start of the body that fits with the note after it.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (make(chars.slice(0, mid).join('') + TRUNCATION_NOTE).length <= max) low = mid
    else high = mid - 1
  }
  return { url: make(chars.slice(0, low).join('') + TRUNCATION_NOTE), truncated: true }
}

// ─── Sending ──────────────────────────────────────────────────────────────────────────────────────────

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`
const firstLine = (text: string) => (text.split('\n').find(line => line.trim()) ?? '').trim().slice(0, 200)

async function openLink($: EngineInterface, url: string): Promise<boolean> {
  const platform = await $.session
    .info()
    .then(info => info.platform)
    .catch(() => 'unknown')
  const argv = platform === 'macos' ? ['open', url] : platform === 'linux' ? ['xdg-open', url] : null
  if (!argv) return false
  try {
    return (await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return false
  }
}

/** A reason gh gave, in one short line: secrets and home-folder paths out. */
async function reasonOf($: EngineInterface, text: string): Promise<string> {
  return firstLine(withoutHome(redactSecrets(text), await homesOf($)))
}

async function linkAnswer($: EngineInterface, draft: Draft, lead: string, dry: boolean): Promise<string> {
  const { url, truncated } = issueUrl(draft)
  const opened = dry ? false : await openLink($, url)
  return [
    lead,
    opened ? 'The link is open in your browser; nothing is created until you press "Submit new issue" there.' : 'Open this link to file it (nothing is created until you press "Submit new issue" there):',
    url,
    truncated ? 'The body was too long for a link and was cut at the end; paste the rest in the issue if it matters.' : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Creates the issue with `gh` when it is installed and signed in, else gives the prefilled link. Called only after the person confirmed. */
export async function send($: EngineInterface, draft: Draft): Promise<string> {
  const dry = ['1', 'true'].includes(((await $.env.get('ALTIMATE_FEEDBACK_DRY_RUN').catch(() => undefined)) ?? '').toLowerCase())
  let signedIn = false
  let why = 'gh is not installed'
  try {
    const status = await $.process.run(['gh', 'auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 })
    signedIn = status.exitCode === 0
    if (!signedIn) why = 'gh is not signed in (run `gh auth login` yourself; the plugin never signs in)'
  } catch (error) {
    if (!MISSING_BINARY.test(String(error))) why = 'gh could not be run'
  }
  if (!signedIn) return linkAnswer($, draft, `${why}, so the issue is not created from here.`, dry)

  let withLabel = false
  if (!dry) {
    try {
      const labels = await $.process.run(['gh', 'label', 'list', '--repo', REPO, '--json', 'name', '--limit', '500'], { timeoutMs: 20_000 })
      const names = labels.exitCode === 0 ? (JSON.parse(labels.stdout) as Array<{ name?: unknown }>) : []
      withLabel = Array.isArray(names) && names.some(one => one?.name === LABEL)
    } catch {
      withLabel = false
    }
  }
  const argv = ['gh', 'issue', 'create', '--repo', REPO, '--title', draft.title, '--body-file', '-', ...(withLabel ? ['--label', LABEL] : [])]
  if (dry) {
    return [`Dry run (${DRY_RUN_ENV} is set): nothing was created. This would run, with the body shown above on stdin:`, argv.map((word, i) => (i === 6 ? quote(word) : word)).join(' '), `(adds --label ${LABEL} when the repository has that label)`].join('\n')
  }
  try {
    const made = await $.process.run(argv, { timeoutMs: 60_000, stdin: draft.body })
    if (made.exitCode === 0) {
      const url = new RegExp(`https://github\\.com/${escapeRegex(REPO)}/issues/\\d+`).exec(made.stdout)?.[0]
      return url ? `Created: ${url}` : 'gh reported success but printed no link; check the repository\'s issues.'
    }
    return linkAnswer($, draft, `gh could not create the issue (${(await reasonOf($, made.stderr || made.stdout)) || `exit ${made.exitCode}`}).`, dry)
  } catch (error) {
    // A call that timed out may have created the issue: it is not retried.
    if (/time(d)? ?out/i.test(String(error))) return 'gh took too long to answer; the issue may have been created. Check the repository\'s issues before trying again.'
    return linkAnswer($, draft, `gh could not create the issue (${await reasonOf($, String(error))}).`, dry)
  }
}

// ─── The command ──────────────────────────────────────────────────────────────────────────────────────

let pending: Draft | null = null
let sending = false
let settings: PluginOptions = {}

const usage = `Say what happened, in your own words:
  /altimate-code:feedback <what happened>
Add ${WITH_ERROR} to attach the last plugin error (redacted). You will see the exact issue before anything is sent.`

function preview(draft: Draft): string {
  return [
    `Draft issue for ${REPO}. Nothing has been sent.`,
    '',
    `Title: ${draft.title}`,
    '',
    'Body:',
    draft.body,
    '',
    '---',
    `Create it: /altimate-code:feedback ${CONFIRM}   (uses gh when it is installed and signed in, else gives a prefilled link)`,
    `Discard it: /altimate-code:feedback ${CANCEL}   ·   Change it: run the command again with new text`,
  ].join('\n')
}

/** The command's answer for `args`; exported for the tests. */
export async function answer($: EngineInterface, args: string): Promise<string> {
  const text = args.trim()
  if (text === CANCEL) {
    const had = pending !== null
    pending = null
    return had ? 'Discarded. Nothing was sent.' : 'There is no draft to discard.'
  }
  if (text === CONFIRM) {
    if (!pending) return `There is no draft to send. Start with /altimate-code:feedback <what happened>.`
    if (sending) return 'The issue is already being created.'
    const draft = pending
    pending = null
    sending = true
    try {
      return await send($, draft)
    } finally {
      sending = false
    }
  }
  const withProblem = new RegExp(`(?:^|\\s)${WITH_ERROR}(?=\\s|$)`).test(text)
  const description = text.replace(new RegExp(`(?:^|\\s)${WITH_ERROR}(?=\\s|$)`, 'g'), ' ').trim()
  if (!description) return usage
  const homes = await homesOf($)
  const facts = await collectFacts($, { withProblem }, { doctor: await dbtModsDoctorFacts($).catch(() => null), settings })
  pending = buildDraft(facts, cleanDescription(description, homes))
  const note = withProblem && !facts.problem ? 'No plugin error has been recorded this session, so none is attached.\n\n' : ''
  return note + preview(pending)
}

/** Registers the command. */
export function registerFeedback(on: On, context: { options: PluginOptions }) {
  settings = context.options ?? {}
  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await answer($, e.args ?? '') }))
}

/** After the session started: the command's place in the slash menu. A new session starts with no draft; an error a feature met while starting stays, as the last one. */
export async function feedbackSessionStart($: EngineInterface) {
  pending = null
  await $.command.register({ name: COMMAND, description: 'Draft a GitHub issue for this plugin from your words and a few redacted facts; created only after you confirm', argumentHint: '<what happened> [--with-error]' })
}

/** The conversation ended: no draft or error outlives it. */
export function feedbackSessionEnd() {
  pending = null
  forgetProblem()
}
