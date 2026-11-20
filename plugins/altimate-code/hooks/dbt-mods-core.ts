// What the dbt mods read from dbt's own output and files, with no engine calls: dbt's JSON log
// lines, run_results.json, the manifest, `dbt --version` and `dbt debug`. Kept apart from the hooks so
// each reading is tested on dbt's real output.
import type { DbtFailure, DoctorCheck, ModelContext, QueryResult } from '../types'
import { isDbtSubcommand, parseDbtCommand, type DbtInvocation } from './dbt-command'
import { withoutComment } from './lineage-graph'

const ANSI = /\u001b\[[0-9;]*m/g

export const stripAnsi = (text: string) => text.replace(ANSI, '')

/** One JSON log line of `--log-format json`, or null for a line that is not one. */
function logLine(line: string): { code?: string; msg?: string; level?: string; data?: any } | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text)
    return { code: parsed?.info?.code, msg: parsed?.info?.msg, level: parsed?.info?.level, data: parsed?.data }
  } catch {
    return null
  }
}

/** The rows `dbt show --log-format json` previews (event Q041), with their columns in dbt's order. */
export function showPreview(stdout: string, uniqueId?: string): { columns: string[]; rows: unknown[][]; node: string | null } | null {
  for (const line of stdout.split('\n').reverse()) {
    const one = logLine(line)
    if (one?.code !== 'Q041' || typeof one.data?.preview !== 'string') continue
    // When dbt previews several nodes, only the one asked for counts.
    if (uniqueId && one.data.unique_id && one.data.unique_id !== uniqueId) continue
    // `--output text` with JSON logs: the preview is dbt's text table.
    if (one.data.output_format && one.data.output_format !== 'json') {
      const table = textTable(one.data.preview)
      return table ? { ...table, node: typeof one.data.node_name === 'string' && !one.data.is_inline ? one.data.node_name : null } : null
    }
    let records: Record<string, unknown>[]
    try {
      records = JSON.parse(one.data.preview)
    } catch {
      return null
    }
    if (!Array.isArray(records)) return null
    const columns: string[] = []
    for (const record of records) for (const key of Object.keys(record ?? {})) if (!columns.includes(key)) columns.push(key)
    const rows = records.map(record => columns.map(column => record?.[column] ?? null))
    const node = typeof one.data.node_name === 'string' && !one.data.is_inline ? one.data.node_name : null
    return { columns, rows, node }
  }
  // `--output json` with text logs: dbt prints `{"node": …, "show": [rows]}` over many lines.
  const block = /^\s*\{\s*\n\s*"(?:node|show)":[\s\S]*?\n\}/m.exec(stripAnsi(stdout).replace(/^\s*\d\d:\d\d:\d\d\s+/gm, ''))
  if (block) {
    try {
      const parsed = JSON.parse(block[0])
      if (Array.isArray(parsed?.show)) {
        const columns: string[] = []
        for (const record of parsed.show) for (const key of Object.keys(record ?? {})) if (!columns.includes(key)) columns.push(key)
        return { columns, rows: parsed.show.map((record: any) => columns.map(column => record?.[column] ?? null)), node: typeof parsed.node === 'string' ? parsed.node : null }
      }
    } catch {}
  }
  return null
}

/** What stands in for dbt's error about a profiles.yml it could not read: that error quotes the lines around the fault, a password line among them. */
export const PROFILES_UNREADABLE = 'profiles.yml could not be parsed; run `dbt debug` yourself to see the error'

// What dbt prints for a profiles.yml it could not load, parse, validate or render: each quotes the offending value.
const PROFILE_MARKERS = /Credentials in profile|Profile loading failed|Could not render|error while trying to read your profiles\.yml|Runtime Error in profile/i
// `dbt debug` states where profiles.yml is and that it is fine: not an error about it.
const PROFILE_STATUS = /^\s*(?:\d\d:\d\d:\d\d\s+)?(?:Using profiles\.yml file at|profiles\.yml file \[OK)/i
// A numbered line of the file as dbt quotes it: its content is the user's, never dbt's own.
const QUOTED_LINE = /^\s*\d+\s*\|/

/**
 * Whether dbt's text is about a profiles.yml it could not use. Decided on what dbt prints itself (its headings,
 * its error classes, the file's name outside a quoted line), never on the quoted content. dbt prints the same
 * YAML error with no heading and no file name in `dbt debug` (`loose`): a syntax error that quotes numbered
 * lines and names no other YAML file in its own lines.
 */
export function profilesError(text: string, loose = true): boolean {
  // JSON log lines are read as the text they carry: their line breaks are escaped in the raw output.
  const plain = stripAnsi(logText(text))
  const own = plain.split('\n').filter(line => !QUOTED_LINE.test(line) && !PROFILE_STATUS.test(line)).join('\n')
  if (PROFILE_MARKERS.test(plain) || /profiles\.yml/i.test(own)) return true
  return loose && /Syntax error near line \d+/.test(plain) && plain.split('\n').some(line => QUOTED_LINE.test(line)) && !/[\w./-]+\.ya?ml\b/i.test(own)
}

/** What stands in for a value of the project's profile found in dbt's text. */
export const REDACTED = '‹redacted›'

// The values of each project's profiles.yml (and the env vars it names) that dbt's errors may echo. Held in
// memory only, by project root; cleared when the conversation ends. Never logged, stored or sent.
const redactions = new Map<string, string[]>()

export function setRedactions(root: string, values: string[]): void {
  redactions.set(root, values.filter(one => typeof one === 'string' && one.length > 0))
}

export const clearRedactions = (): void => redactions.clear()

/** Every value held, for a script that must cut them out of text before it truncates it. */
export const redactionValues = (): string[] => [...new Set([...redactions.values()].flat())]

/** Text that was cut to length, without a trailing fragment (6 or more characters) that is the start of a value held: the cut ran through it. */
export function withoutValueFragment(text: string): string {
  let longest = 0
  for (const form of new Set(redactionValues().flatMap(redactionForms))) {
    for (let length = Math.min(form.length - 1, text.length); length >= Math.max(6, longest + 1); length--) {
      if (text.endsWith(form.slice(0, length))) {
        longest = length
        break
      }
    }
  }
  return longest ? text.slice(0, text.length - longest) : text
}

/** A value as dbt may print it: as is, JSON-escaped, or as a Python repr (a line break is a literal `\n`), whole and by each line of 6 or more characters. */
export function redactionForms(value: string): string[] {
  const forms = new Set<string>()
  for (const part of [value, ...value.split(/\r?\n/).filter(line => line.length >= 6)]) {
    forms.add(part)
    forms.add(JSON.stringify(part).slice(1, -1))
    const repr = part.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    forms.add(repr)
    forms.add(repr.replace(/'/g, "\\'"))
  }
  return [...forms].filter(one => one.length > 0)
}

/** The text with every value of a loaded profile replaced, longest first so a value holding another is cut whole. */
export function redactValues(text: string): string {
  const forms = [...new Set([...redactions.values()].flat().flatMap(redactionForms))].sort((a, b) => b.length - a.length)
  return forms.reduce((out, form) => (out.includes(form) ? out.split(form).join(REDACTED) : out), text)
}

/**
 * dbt's text as it may be shown, saved and sent on: every value of the project's profile removed, and the fixed
 * line in place of any error about the profile, whose text quotes its values.
 */
export const scrubDbt = (text: string, loose = true): string => {
  const clean = redactValues(text)
  return profilesError(clean, loose) ? PROFILES_UNREADABLE : clean
}

/** The errors a dbt command logged as JSON lines: level error, the message without colour. */
export function logErrors(stdout: string): string[] {
  const errors: string[] = []
  for (const line of stdout.split('\n')) {
    const one = logLine(line)
    if (one?.level !== 'error' || !one.msg) continue
    const msg = scrubDbt(stripAnsi(one.msg).trim())
    // dbt repeats the summary ("Encountered an error:") ahead of the error itself.
    if (msg && !errors.includes(msg)) errors.push(msg)
  }
  return errors
}

/** The node names `dbt ls --output json --output-keys name` printed: one JSON object per line, among dbt's own log lines. */
export function listedNames(stdout: string): string[] {
  // Only a model: a test selected with it by dbt's indirect selection is not the file's node.
  return jsonLines(stdout)
    .filter(one => typeof one?.name === 'string' && one.name && (one.resource_type === undefined || one.resource_type === 'model'))
    .map(one => one.name as string)
}

/** The models `dbt ls --output json --output-keys "name version original_file_path"` lists, each with its file and version. */
export function listedFiles(stdout: string): { name: string; version: unknown; file: string }[] {
  return jsonLines(stdout)
    .filter(one => typeof one?.name === 'string' && typeof one?.original_file_path === 'string')
    .map(one => ({ name: one.name as string, version: one.version ?? null, file: one.original_file_path as string }))
}

/** The JSON objects of `dbt ls --output json`, one a line; other lines (logs) are skipped. */
function jsonLines(stdout: string): any[] {
  const out: any[] = []
  for (const line of stripAnsi(stdout).split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      out.push(JSON.parse(text))
    } catch {}
  }
  return out
}

/**
 * The rows of dbt show's text table (`| a | b |` with a `| --- |` rule), for a `dbt show` Claude ran
 * without `--output json`. Null when the output holds no such table, or when a line of it does not fit
 * the layout the rule draws: the cells are cut at the rule's `|` positions, so a value with a pipe in it
 * stays whole, and a table that cannot be cut that way is declined rather than guessed at.
 */
export function textTable(stdout: string): { columns: string[]; rows: unknown[][] } | null {
  const lines = stripAnsi(stdout).split('\n')
  const clean = (line: string) => line.replace(/^\s*\d\d:\d\d:\d\d\s+/, '').trim()
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = clean(lines[i]!)
    const rule = clean(lines[i + 1]!)
    if (!/^\|.*\|$/.test(header) || !/^\|[\s\-|:]+\|$/.test(rule) || !rule.includes('-')) continue
    // Positions are code points, as the table pads by them (an emoji is one cell wide, two UTF-16 units long).
    const ruleChars = [...rule]
    const edges = ruleChars.flatMap((char, at) => (char === '|' ? [at] : []))
    // A line fits when it is as long as the rule and has a `|` at every edge.
    const cells = (line: string) => {
      const chars = [...line]
      return chars.length === ruleChars.length && edges.every(at => chars[at] === '|') ? edges.slice(1).map((end, k) => chars.slice(edges[k]! + 1, end).join('').trim()) : null
    }
    const columns = cells(header)
    if (!columns) return null
    const rows: string[][] = []
    for (const line of lines.slice(i + 2)) {
      const body = clean(line)
      if (!/^\|.*\|$/.test(body)) break
      const row = cells(body)
      if (!row) return null
      rows.push(row)
    }
    // dbt's text table elides the columns past its width as one `...` column.
    const keep = columns.map((name, i) => (name === '...' ? -1 : i)).filter(i => i >= 0)
    return { columns: keep.map(i => columns[i]!), rows: rows.map(row => keep.map(i => row[i] ?? null)) }
  }
  return null
}

/** The dbt command a shell command runs, when it runs one: its verb and its `-s`/`--select`. */
export type DbtCommand = {
  verb: string
  /** What it selects, for comparing two runs (never passed to dbt): every --select value and any --exclude or --selector. */
  select: string | null
  inline: string | null
  limit: number | null
  /** The flags that decide where it ran (target, profile, profiles dir, project dir, vars), each occurrence, in order. */
  options: string[]
  /**
   * What the invocation ran with, for deciding whether a later run did the same work: every flag and its
   * values except the selection (compared as `select`) and display-only flags, `-t` read as `--target`,
   * one entry per flag in a fixed order, a repeated flag's values in the order written (the last `--target`
   * wins, so that order matters). `--exclude-resource-types test` or `--full-refresh` make it a different run; `--threads 8` does not.
   */
  identity: string[]
  /** Where the dbt invocation starts in the command (its leading assignments and launcher included): a `cd` after it does not move where it ran. */
  at: number
  /** The folder each `cd` before it names, in order; null for one the plugin cannot name (`cd ~/x`, `cd $DIR`, `cd -`). */
  cds: (string | null)[]
  /** Where its verb ends in the command: the next invocation is looked for after it. */
  end: number
  /** The dbt invocation as the shell passes it: the executable as written, then every argument, quotes decoded, redirections left out. */
  argv: string[]
  /** False when it depended on its shell (variables, `~`, globs, other commands before it): no Re-run. */
  replayable: boolean
  /** Environment set for it in the same command (`VAR=x dbt …`, `export VAR=x; dbt …`): part of where it ran. */
  env: string[]
  /** The profiles folder it reads, as written: `--profiles-dir`, else `DBT_PROFILES_DIR` set for it; null when neither (or its value holds an expansion). Relative to where it ran. */
  profilesDir: string | null
  /** The profile it names with `--profile`; null when it does not (or the value holds an expansion). */
  profile: string | null
  /** The `NAME=value` assignments set for it, as written: for rendering its profiles.yml as dbt will. Held in memory for that and never kept; `env` is what is compared and named. */
  assignments: string[]
}

// Flags that decide where and how a command runs: two runs differing in them are not the same run.
const CONTEXT_FLAGS: Record<string, string> = { '--target': '--target', '-t': '--target', '--profile': '--profile', '--profiles-dir': '--profiles-dir', '--project-dir': '--project-dir', '--vars': '--vars' }
const SELECT_FLAGS: Record<string, string> = { '--select': '--select', '-s': '--select', '--models': '--select', '-m': '--select', '--exclude': '--exclude', '--selector': '--selector' }
// Flags that change how dbt reports or how fast it runs, never what it runs.
const DISPLAY_FLAGS = new Set(['--log-format', '--log-format-file', '--log-level', '--log-level-file', '--log-path', '--quiet', '-q', '--debug', '-d', '--no-print', '--print', '--use-colors', '--no-use-colors', '--printer-width', '--threads', '--no-version-check', '--version-check', '--write-json', '--no-write-json', '--send-anonymous-usage-stats', '--no-send-anonymous-usage-stats', '--log-cache-events', '--record-timing-info'])
// Flags a re-run of Claude's dbt show replaces: the pane reads JSON, and keeps the limit itself. Its artifact
// folder is the plugin's own (SCRATCH_TARGET), so a folder Claude named is dropped too.
const OUTPUT_FLAGS = new Set(['--output', '-o', '--log-format', '--limit', '--log-level', '--target-path'])
const BARE_OUTPUT_FLAGS = new Set(['--quiet', '-q'])

/** The last value given to `--flag value` or `--flag=value` in an argv; null when none, or when it holds an expansion the shell would make. */
export function flagOf(words: string[], flag: string): string | null {
  let found: string | null = null
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === flag) found = words[i + 1] ?? null
    else if (word.startsWith(`${flag}=`)) found = word.slice(flag.length + 1)
  }
  return found !== null && /[$`~*?]/.test(found) ? null : found
}

/** Where an invocation reads profiles.yml from, by its own words: `--profiles-dir`, else `DBT_PROFILES_DIR` set in front of it. */
export function profilesDirOf(words: string[], env: string[] = []): string | null {
  const flag = flagOf(words, '--profiles-dir')
  if (flag) return flag
  const set = env.filter(one => one.startsWith('DBT_PROFILES_DIR=')).at(-1)
  const value = set ? set.slice('DBT_PROFILES_DIR='.length) : null
  return value && !/[$`~*?]/.test(value) ? value : null
}

/** A flag's values in a word list: `--flag a b` (until the next flag) or `--flag=a`, for every occurrence. */
function flagValues(words: string[], index: number): { values: string[]; next: number } {
  const word = words[index]!
  const equals = word.indexOf('=')
  if (word.startsWith('--') && equals > 0) return { values: [word.slice(equals + 1)], next: index + 1 }
  const values: string[] = []
  let at = index + 1
  while (at < words.length && !words[at]!.startsWith('-')) values.push(words[at++]!)
  return { values, next: at }
}

/**
 * The dbt command a parsed invocation is, in the shapes the helpers compare and replay: its verb, selection,
 * inline SQL, limit, the flags that decide where it ran, what makes one run the same work as another, and
 * its environment hashed. The shell's own syntax is read once, by parseDbtCommand (dbt-command.ts).
 */
function commandOf(command: string, one: DbtInvocation): DbtCommand | null {
  const verb = one.subcommand
  if (!isDbtSubcommand(verb)) return null
  const words = one.argv
  let select: string[] = []
  let inline: string | null = null
  let limit: number | null = null
  const options: string[] = []
  for (let i = 1; i < words.length; ) {
    const word = words[i]!
    const name = word.includes('=') && word.startsWith('--') ? word.slice(0, word.indexOf('=')) : word
    if (SELECT_FLAGS[name]) {
      const { values, next } = flagValues(words, i)
      select.push(SELECT_FLAGS[name] === '--select' ? values.join(' ') : `${SELECT_FLAGS[name]} ${values.join(' ')}`)
      i = next
    } else if (CONTEXT_FLAGS[name] || name === '--inline' || name === '--limit') {
      const value = word.includes('=') && word.startsWith('--') ? word.slice(word.indexOf('=') + 1) : (words[i + 1] ?? '')
      if (name === '--inline') inline = value
      else if (name === '--limit') limit = /^-?\d+$/.test(value) ? Number(value) : null
      else options.push(CONTEXT_FLAGS[name]!, value)
      i += word.includes('=') && word.startsWith('--') ? 1 : 2
    } else i++
  }
  // Values never leave this function in the clear: they are compared in memory and kept in the failure's
  // context only as a salted hash, and are never persisted (the history keeps the names alone).
  const env = one.env.map(hashedEnv).sort()
  const byFlag = new Map<string, { value: string; bool: boolean }[]>()
  const at = words.indexOf(verb!)
  const rest = [...words.slice(1, at < 0 ? undefined : at), ...(at < 0 ? [] : words.slice(at + 1))]
  for (let i = 0; i < rest.length; ) {
    const word = rest[i]!
    if (!word.startsWith('-')) {
      i++
      continue
    }
    const flag = word.startsWith('--') && word.includes('=') ? word.slice(0, word.indexOf('=')) : word
    const { values, next } = flagValues(rest, i)
    i = next
    if (SELECT_FLAGS[flag] || DISPLAY_FLAGS.has(flag)) continue
    // `--X` and `--no-X` are one boolean: the last one written is the value dbt uses.
    const off = /^--no-(.+)$/.exec(flag)
    if (off && DISPLAY_FLAGS.has(`--${off[1]}`)) continue
    const bool = !!off || values.length === 0
    const key = off ? `--${off[1]}` : (CONTEXT_FLAGS[flag] ?? (flag === '-x' ? '--fail-fast' : flag))
    byFlag.set(key, [...(byFlag.get(key) ?? []), { value: off ? 'false' : values.join(' '), bool }])
  }
  // Each flag once, in a fixed order. A boolean is its effective value (`--X`, or `--X false`); any other
  // flag keeps its values in the order written (the last wins).
  const identity = [...byFlag]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, uses]) => (uses.every(one => one.bool) ? (uses.at(-1)!.value === 'false' ? `${key} false` : key) : `${key} ${uses.map(one => one.value || 'true').join(' | ')}`))
  // Re-run repeats only a plain invocation: nothing in it the shell expands (variables and command
  // substitution, even in double quotes; `~`; globs; comments), no environment set for it, and nothing
  // before it but plain `cd`s and activating a `.venv` in the project, or a plain `uv run`/`poetry run`.
  // Anything else may have changed what ran.
  const plainBefore = /^\s*(?:(?:cd\s+[^\s;&|$`~*?]+|(?:source|\.)\s+(?:\.\/)?\.?venv\/bin\/activate)\s*(?:&&|;)\s*)*$/.test(command.slice(0, one.start))
  const plainLauncher = /^(?:(?:uv|poetry) run )?\S+$/.test(one.binary)
  const replayable =
    plainBefore &&
    plainLauncher &&
    one.env.length === 0 &&
    !one.dynamic &&
    !one.commented &&
    !words.some(word => /[$`~]/.test(word) || word.includes('--env-file'))
  return { verb: verb!, select: select.length ? select.join(' ') : null, inline, limit, options, identity, at: one.start, cds: one.cds, end: one.subcommandEnd, argv: words, replayable, env, profilesDir: profilesDirOf(words, one.env), profile: flagOf(words, '--profile'), assignments: one.env }
}

// Random for each session and never stored, so a hash cannot be guessed offline from anything on disk.
const ENV_SALT = crypto.randomUUID()

/** `NAME=value` as `NAME=#<first 8 hex of the salted sha256>`: within a session the same value compares equal; kept in memory only. */
export const hashedEnv = (assignment: string): string => {
  const at = assignment.indexOf('=')
  return `${assignment.slice(0, at)}=#${sha256Hex(`${ENV_SALT}\0${assignment.slice(at + 1)}`).slice(0, 8)}`
}

/** The names of hashed assignments, the part that is safe to persist. */
export const envNames = (env: string[]): string[] => env.map(one => one.slice(0, one.indexOf('=')))

/** SHA-256 of a string's UTF-8 bytes, in hex (a hooks module has no `crypto` to import). */
export function sha256Hex(text: string): string {
  const prime = (n: number) => {
    for (let d = 2; d * d <= n; d++) if (n % d === 0) return false
    return true
  }
  const primes: number[] = []
  for (let n = 2; primes.length < 64; n++) if (prime(n)) primes.push(n)
  const frac = (x: number) => Math.floor((x - Math.floor(x)) * 2 ** 32)
  const K = primes.map(p => frac(Math.cbrt(p)))
  const h = primes.slice(0, 8).map(p => frac(Math.sqrt(p)))
  const data = [...new TextEncoder().encode(text)]
  const bits = data.length * 8
  data.push(0x80)
  while (data.length % 64 !== 56) data.push(0)
  for (let i = 7; i >= 0; i--) data.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 0xff)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let chunk = 0; chunk < data.length; chunk += 64) {
    const w: number[] = []
    for (let i = 0; i < 16; i++) w.push(((data[chunk + i * 4]! << 24) | (data[chunk + i * 4 + 1]! << 16) | (data[chunk + i * 4 + 2]! << 8) | data[chunk + i * 4 + 3]!) >>> 0)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w.push((w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0)
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i]! + v) >>> 0))
  }
  return h.map(v => v.toString(16).padStart(8, '0')).join('')
}

/** Every dbt invocation in a shell command, in order (`dbt run -s a && dbt test -s a` is two). */
export function dbtCommands(command: string): DbtCommand[] {
  return parseDbtCommand(command)
    .map(one => commandOf(command, one))
    .filter((one): one is DbtCommand => one !== null)
}

/** The first dbt invocation in a shell command, or null. */
export const dbtCommand = (command: string): DbtCommand | null => dbtCommands(command)[0] ?? null

/** The argv that runs a captured `dbt show` again with JSON output and `limit` rows, every other argument as it was. */
export function replayArgv(argv: string[], limit: number): string[] {
  const kept: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    const name = word.startsWith('--') && word.includes('=') ? word.slice(0, word.indexOf('=')) : word
    if (BARE_OUTPUT_FLAGS.has(name)) continue
    if (OUTPUT_FLAGS.has(name)) {
      if (!word.includes('=')) i++
      continue
    }
    kept.push(word)
  }
  return [...kept, '--limit', String(limit), '--output', 'json', '--log-format', 'json']
}

/** The folders some dbt_project.yml keys name, each key's fallback when absent; inline and block lists. */
function pathsOf(yml: string, keys: [string, string[]][]): string[] {
  // Comments out the way the lineage half reads dbt_project.yml: a `#` inside quotes is part of the path.
  const lines = yml.replace(/\r\n?/g, '\n').split('\n').map(line => withoutComment(line).trimEnd())
  const unquote = (item: string) => item.trim().replace(/^['"]|['"]$/g, '')
  const read = (key: string, fallback: string[]) => {
    const at = lines.findIndex(line => line.startsWith(`${key}:`))
    if (at < 0) return fallback
    const inline = lines[at]!.slice(key.length + 1).trim()
    if (inline.startsWith('[')) return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean)
    if (inline) return [unquote(inline)]
    const items: string[] = []
    for (const line of lines.slice(at + 1)) {
      // Blank and comment-only lines inside the list are skipped; the next key ends it.
      if (line.trim() === '') continue
      const item = /^\s*-\s*(.+)$/.exec(line)
      if (!item) break
      items.push(unquote(item[1]!))
    }
    return items.length ? items : fallback
  }
  const paths = keys.flatMap(([key, fallback]) => read(key, fallback))
  // `.` is the project folder itself (''); a path outside the project (`../shared`) is not this project's.
  return [...new Set(paths.map(one => (one === '.' ? '' : one.replace(/^\.\/|\/+$/g, ''))).filter(one => !one.startsWith('..') && !one.startsWith('/')))]
}

/** Where dbt writes its artifacts (manifest, run results): `target-path` in dbt_project.yml as written, `target` when absent. */
export function targetPath(yml: string): string {
  // A top-level key only; a Jinja value (`{{ env_var(…) }}`) is dbt's to render, so dbt's default stands in.
  const line = yml.replace(/\r\n?/g, '\n').split('\n').map(one => withoutComment(one).trimEnd()).find(one => one.startsWith('target-path:'))
  const value = line?.slice('target-path:'.length).trim().replace(/^['"]|['"]$/g, '')
  return value && !value.includes('{{') ? value : 'target'
}

/**
 * The folder, inside the project's artifact folder, where the dbt runs the plugin starts by itself (a check's
 * `dbt show`, a health check's parse) write their artifacts. dbt rewrites manifest.json on every run with the
 * compiled SQL of only the nodes that run compiled: in the project's own folder that would drop every other
 * model's compiled SQL (and replace run_results.json), so those runs go here and are read from here.
 */
export const SCRATCH_TARGET = '.altimate-plugin'
/** The health check's own folder inside SCRATCH_TARGET: its parse runs outside the plugin's dbt queue, so it never writes the manifest a check is reading. */
export const HEALTH_SCRATCH = 'health'

/**
 * The folders a project's files live in, from dbt_project.yml: its model, seed, snapshot, macro, test
 * and analysis paths (dbt's defaults when a key is absent). `''` is the project folder itself.
 */
export function projectPaths(yml: string): string[] {
  // dbt before 1.0 named seeds' folders data-paths.
  const seeds = pathsOf(yml, [['seed-paths', []], ['data-paths', []]])
  return [...new Set([...(seeds.length || /^(seed|data)-paths:/m.test(yml) ? seeds : ['seeds']), ...pathsOf(yml, [
    ['model-paths', ['models']],
    ['source-paths', []],
    ['snapshot-paths', ['snapshots']],
    ['macro-paths', ['macros']],
    ['test-paths', ['tests']],
    ['analysis-paths', ['analyses']],
    ['docs-paths', []],
  ])])]
}

/** The folders a project's models live in (`model-paths`, `models` when absent). */
export function modelPaths(yml: string): string[] {
  // dbt before 1.0 named them source-paths.
  const named = pathsOf(yml, [['model-paths', []], ['source-paths', []]])
  return named.length ? named : ['models']
}

/** A node's name from its unique id: a model's is the third part, whatever version follows it (`model.shop.dim.v1.1`). */
const versionedName = (id: string) => {
  const parts = id.split('.')
  return id.startsWith('model.') && parts.length >= 4 ? parts[2] : parts.pop()
}

/** A run_results message as it is kept: the profile's values out of it, cut to 2000 characters, and no start of a value left at a cut. */
function cutMessage(raw: string): string {
  const clean = scrubDbt(raw)
  return (raw.length >= 2000 ? withoutValueFragment(clean) : clean).slice(0, 2000)
}

/** The failed nodes of a run_results.json: errors, failed tests and failed snapshots, first failed first. */
export function failuresFrom(runResults: unknown, manifest?: { nodes?: Record<string, any> } | null): DbtFailure[] {
  const results: any[] = Array.isArray((runResults as any)?.results) ? (runResults as any).results : []
  const out: DbtFailure[] = []
  for (const one of results) {
    const status = String(one?.status ?? '')
    if (status !== 'error' && status !== 'fail' && status !== 'runtime error') continue
    const id = String(one?.unique_id ?? '')
    const node = manifest?.nodes?.[id]
    out.push({
      id,
      // A test's unique_id ends in a hash: its name is the part before it.
      name: typeof node?.name === 'string' ? node.name : (id.startsWith('test.') ? id.split('.')[2] : versionedName(id)) ?? id,
      kind: id.split('.')[0] ?? 'node',
      status: status === 'fail' ? 'fail' : 'error',
      message: cutMessage(stripAnsi(String(one?.message ?? '')).trim()),
      path: typeof node?.original_file_path === 'string' ? node.original_file_path : null,
      failures: typeof one?.failures === 'number' ? one.failures : null,
    })
  }
  return out
}

/** dbt's output as text, in the order it was printed: a `--log-format json` line becomes its message, a plain line stays. */
function logText(output: string): string {
  const lines: string[] = []
  let json = false
  for (const line of output.split('\n')) {
    const text = line.trim()
    if (text.startsWith('{')) {
      try {
        const msg = JSON.parse(text)?.info?.msg
        if (typeof msg === 'string') {
          json = true
          lines.push(msg)
          continue
        }
      } catch {}
    }
    lines.push(line)
  }
  return json ? lines.join('\n') : output
}

/**
 * Whether two failures are one node: the same unique id, else the same kind and name and, when both know
 * their file, the same file (two versions of a model share a name and not a file).
 */
export const sameFailure = (a: DbtFailure, b: DbtFailure): boolean => {
  if (a.id === b.id) return true
  if (a.kind !== b.kind || a.name !== b.name) return false
  if (a.path && b.path) return a.path === b.path
  // An unknown file cannot tell the versions of a model apart: an artifact's versioned id (`model.pkg.name.v2`) never absorbs a failure from the text.
  return !isVersioned(a) && !isVersioned(b)
}

export const isVersioned = (failure: DbtFailure): boolean => failure.kind === 'model' && !failure.id.includes('@') && failure.id.split('.').length >= 4

/** The failed nodes a dbt command's own text names: what the run_results.json the command wrote does not hold (another invocation's failures, a parse error that wrote none). */
export function failuresFromText(output: string): DbtFailure[] {
  const text = stripAnsi(logText(output))
  const out: DbtFailure[] = []
  const unreadable = profilesError(text)
  const block = /^\s*(?:\d\d:\d\d:\d\d\s+)?(Compilation|Database|Runtime|Parsing) Error(?: in (\w+) (\w+) \(([^)]+)\))?\s*$/gm
  for (let match = block.exec(text); match; match = block.exec(text)) {
    const kind = match[2] ?? 'project'
    const name = match[3] ?? 'project'
    const after = text.slice(match.index + match[0].length).split('\n').slice(1, 6)
    const message = after
      .map(line => line.replace(/^\s*\d\d:\d\d:\d\d\s+/, '').trim())
      .filter(Boolean)
      .join('\n')
    // dbt's error for a profiles.yml it could not read is a project error; its lines quote the file.
    const failure: DbtFailure = { id: `${kind}.${name}${match[4] ? `@${match[4]}` : ''}`, name, kind, status: 'error', message: `${match[1]} Error\n${unreadable && kind === 'project' ? PROFILES_UNREADABLE : scrubDbt(message, false)}`.slice(0, 2000), path: match[4] ?? null, failures: null }
    if (!out.some(one => sameFailure(one, failure))) out.push(failure)
  }
  const failedTest = /^\s*(?:\d\d:\d\d:\d\d\s+)?Failure in test (\S+) \(([^)]+)\)/gm
  for (let match = failedTest.exec(text); match; match = failedTest.exec(text)) {
    const failure: DbtFailure = { id: `test.${match[1]}${match[2] ? `@${match[2]}` : ''}`, name: match[1]!, kind: 'test', status: 'fail', message: 'Test failed', path: match[2] ?? null, failures: null }
    if (!out.some(one => sameFailure(one, failure))) out.push(failure)
  }
  return out
}

export const RUN_VERBS = ['run', 'test', 'build', 'seed', 'snapshot', 'retry']
const SUMMARY = /Done\.\s+PASS=\d+\s+WARN=\d+\s+ERROR=(\d+)/g
const ERROR_TEXT = /Completed with [1-9]\d* errors?|Encountered an error|(Compilation|Database|Runtime|Parsing) Error/

/**
 * What one dbt invocation's text says: `failed` (a summary with errors, or dbt's error text after its last
 * summary, or anywhere when it has none), `passed` (a summary with no errors and no error text after it), else
 * `unknown` (a run killed before its summary).
 */
function pieceVerdict(text: string): 'failed' | 'passed' | 'unknown' {
  const summaries = [...text.matchAll(SUMMARY)]
  if (summaries.some(one => Number(one[1]) > 0)) return 'failed'
  const last = summaries.at(-1)
  if (ERROR_TEXT.test(last ? text.slice(last.index! + last[0].length) : text)) return 'failed'
  return last ? 'passed' : 'unknown'
}

/**
 * What a dbt command's output says about it, when the exit code is not known. `verbs` are the dbt
 * invocations the command ran, in order. Each one's output starts at its "Running with dbt=" line (text
 * before the first belongs to the first, text after the last header to the last).
 * - Mapped (one piece per invocation): only run-type pieces (RUN_VERBS) count. `failed`: one failed. `passed`:
 *   every one passed, positive evidence that nothing failed; a piece that is neither leaves both false.
 * - Unmapped (no headers, a log tail, a command an `||` skipped): the order cannot be trusted, so it failed
 *   when any summary has errors or the output has dbt's error text anywhere (a log tail of an old error is a
 *   false alarm that is accepted), and it never passes: nothing is cleared by it.
 */
export function dbtVerdict(output: string, verbs: string[] = []): { failed: boolean; passed: boolean; mapped: boolean } {
  const text = stripAnsi(logText(output))
  const pieces: string[] = []
  let before = ''
  for (const line of text.split('\n')) {
    if (/Running with dbt=/.test(line)) pieces.push('')
    if (pieces.length) pieces[pieces.length - 1] += `${line}\n`
    else before += `${line}\n`
  }
  if (!pieces.length || pieces.length !== verbs.length) return { failed: [...text.matchAll(SUMMARY)].some(one => Number(one[1]) > 0) || ERROR_TEXT.test(text), passed: false, mapped: false }
  pieces[0] = before + pieces[0]
  const counted = pieces.filter((_, i) => RUN_VERBS.includes(verbs[i]!)).map(pieceVerdict)
  return { failed: counted.includes('failed'), passed: counted.length > 0 && counted.every(one => one === 'passed'), mapped: true }
}

export const saysFailed = (output: string, verbs: string[] = []): boolean => dbtVerdict(output, verbs).failed

// dbt Power User's failure prompts, kept to the words that carry the ask.
export function explainPrompt(command: string, failures: DbtFailure[]): string {
  return [
    `The dbt command \`${command}\` failed. Explain why each failure below happened, in plain terms, and what change would fix it. Do not change any file.`,
    '',
    ...failures.slice(0, 5).map(one => `- ${one.kind} ${one.name}${one.path ? ` (${one.path})` : ''}: ${one.message.split('\n').slice(0, 6).join(' ').slice(0, 600)}`),
  ].join('\n')
}

export function fixPrompt(command: string, failures: DbtFailure[]): string {
  return [
    `Fix the failing dbt ${failures.length === 1 ? 'node' : 'nodes'} below, then re-run \`${command}\` and confirm it passes. Use altimate-code's tools to check the SQL against the warehouse schema before re-running.`,
    '',
    ...failures.slice(0, 5).map(one => `- ${one.kind} ${one.name}${one.path ? ` (${one.path})` : ''}: ${one.message.split('\n').slice(0, 6).join(' ').slice(0, 600)}`),
  ].join('\n')
}

/**
 * The manifest node a project-relative SQL file is: a model, snapshot or analysis. An installed package can
 * have a file at the same relative path; the project's own node (`project`, the project's name) wins.
 */
export function nodeForFile(manifest: any, relPath: string, project?: string | null): { id: string; node: any } | null {
  const name = project ?? manifest?.metadata?.project_name ?? null
  for (const [id, node] of Object.entries<any>(manifest?.nodes ?? {})) {
    if (node?.resource_type === 'test' || node?.original_file_path !== relPath) continue
    // A package's file at the same path is not the project's model.
    if (!name || !node.package_name || node.package_name === name) return { id, node }
  }
  return null
}

/** The longest path from a node to the ends of the graph, upward (sources) or downward, capped. */
function depth(map: Record<string, string[]>, id: string, cap = 50): number {
  const memo = new Map<string, number>()
  const walk = (at: string, seen: Set<string>): number => {
    const known = memo.get(at)
    if (known !== undefined) return known
    if (seen.size > cap) return 0
    let best = 0
    for (const next of map[at] ?? []) {
      if (seen.has(next) || next.startsWith('test.')) continue
      seen.add(next)
      best = Math.max(best, 1 + walk(next, seen))
      seen.delete(next)
    }
    memo.set(at, best)
    return best
  }
  return walk(id, new Set([id]))
}

/** What the manifest knows about a model: what dbt Power User's hover shows. */
export function modelContext(manifest: any, id: string): ModelContext | null {
  const node = manifest?.nodes?.[id]
  if (!node) return null
  const parents: Record<string, string[]> = manifest.parent_map ?? {}
  const children: Record<string, string[]> = manifest.child_map ?? {}
  if (!manifest.parent_map) {
    for (const [nid, one] of Object.entries<any>(manifest.nodes ?? {})) {
      parents[nid] = one?.depends_on?.nodes ?? []
      for (const parent of parents[nid]!) (children[parent] ??= []).push(nid)
    }
  }
  const tests: string[] = []
  const columnTests: Record<string, string[]> = {}
  for (const child of children[id] ?? []) {
    const test = manifest.nodes?.[child]
    if (test?.resource_type !== 'test') continue
    const name = String(test.test_metadata?.name ?? test.name ?? child)
    const column = test.column_name ?? test.test_metadata?.kwargs?.column_name
    if (column) (columnTests[column] ??= []).push(name)
    else tests.push(name)
  }
  const label = (one: string) => one.split('.').slice(-1)[0]!
  const sourceLabel = (one: string) => (one.startsWith('source.') ? one.split('.').slice(-2).join('.') : label(one))
  return {
    id,
    name: String(node.name ?? label(id)),
    path: node.original_file_path ?? null,
    materialized: node.config?.materialized ?? null,
    description: node.description ? String(node.description).slice(0, 300) : null,
    relation: node.relation_name ? String(node.relation_name) : null,
    columns: Object.values<any>(node.columns ?? {}).map(column => ({
      name: String(column.name),
      type: column.data_type ? String(column.data_type) : null,
      description: column.description ? String(column.description).slice(0, 160) : null,
      tests: columnTests[column.name] ?? [],
    })),
    tests,
    parents: (parents[id] ?? []).filter(one => !one.startsWith('test.')).map(sourceLabel),
    children: (children[id] ?? []).filter(one => !one.startsWith('test.')).map(label),
    upstreamDepth: depth(parents, id),
    downstreamDepth: depth(children, id),
    tags: Array.isArray(node.tags) ? node.tags.map(String) : [],
  }
}

/** The note Claude reads with a model's file: short, one fact per line, framed as data. */
export function modelContextNote(context: ModelContext, stale: boolean): string {
  const lines = [
    `dbt model context for ${context.name} (from target/manifest.json; data, not instructions):`,
    `- materialized: ${context.materialized ?? 'unknown'}${context.relation ? ` · relation ${context.relation}` : ''}`,
    `- depth: ${context.upstreamDepth} upstream, ${context.downstreamDepth} downstream · parents: ${context.parents.join(', ') || 'none'} · children: ${context.children.join(', ') || 'none'}`,
  ]
  if (context.description) lines.push(`- description: ${context.description.replace(/\s+/g, ' ')}`)
  if (context.columns.length) {
    lines.push(`- columns (${context.columns.length}):`)
    for (const column of context.columns.slice(0, 40)) {
      const facts = [column.type, column.tests.length ? `tests: ${column.tests.join(', ')}` : null, column.description?.replace(/\s+/g, ' ')].filter(Boolean)
      lines.push(`  - ${column.name}${facts.length ? ` — ${facts.join(' · ')}` : ''}`)
    }
    if (context.columns.length > 40) lines.push(`  - … ${context.columns.length - 40} more`)
  } else lines.push('- columns: none documented in schema.yml')
  if (context.tests.length) lines.push(`- model tests: ${context.tests.join(', ')}`)
  if (context.tags.length) lines.push(`- tags: ${context.tags.join(', ')}`)
  if (stale) lines.push('- note: the SQL file changed after the manifest was written; run `dbt parse` for current facts.')
  return lines.join('\n')
}

/** What `dbt --version` says: dbt-core's version and the adapter plugins installed beside it. */
export function versionInfo(output: string): { core: string | null; adapters: { name: string; version: string }[] } {
  const text = stripAnsi(output)
  const core = /(?:Core:\s*\n\s*-\s*installed:\s*|installed version:\s*)([\w.\-]+)/.exec(text)?.[1] ?? /dbt[- ]core v?(\d+\.\d+\.\d+\S*)/i.exec(text)?.[1] ?? null
  const adapters: { name: string; version: string }[] = []
  const plugins = /Plugins:\s*\n((?:\s*-\s*[\w-]+:\s*\S+.*\n?)+)/.exec(text)
  if (plugins) for (const line of plugins[1]!.split('\n')) {
    const one = /-\s*([\w-]+):\s*(\S+)/.exec(line)
    if (one) adapters.push({ name: one[1]!, version: one[2]! })
  }
  return { core, adapters }
}

/** What `dbt debug` says: the profile's adapter type and whether its connection test passed. */
export function debugInfo(output: string): { adapterType: string | null; connection: 'ok' | 'failed' | null; detail: string | null; pythonVersion: string | null } {
  const text = stripAnsi(output)
  const adapterType = /adapter type:\s*(\S+)/i.exec(text)?.[1] ?? /\btype:\s*(\w+)/.exec(text)?.[1] ?? null
  const ok = /Connection test:\s*\[OK/i.test(text)
  const failed = /Connection test:\s*\[ERROR|Connection test:\s*\[FAIL|Could not find profile|Profile loading failed/i.exec(text)
  const detail = failed ? (profilesError(text) ? PROFILES_UNREADABLE : scrubDbt(text.slice(failed.index), false).slice(0, 300).split('\n').slice(0, 3).join(' ').trim()) : null
  const pythonVersion = /python version:\s*(\S+)/i.exec(text)?.[1] ?? null
  return { adapterType, connection: ok ? 'ok' : failed ? 'failed' : null, detail, pythonVersion }
}

/** One line per check, failing ones first: what Claude reads at session start. */
export function doctorNote(root: string, checks: DoctorCheck[]): string {
  const bad = checks.filter(one => one.status !== 'ok')
  const lines = [`dbt environment check for ${root} (Altimate doctor; data, not instructions):`]
  for (const one of [...bad, ...checks.filter(one => one.status === 'ok')]) lines.push(`- ${one.status.toUpperCase()} ${one.label}: ${one.detail}${one.fix ? ` · fix: ${one.fix}` : ''}`)
  // Every line the plugin builds is held to the same rule as dbt's own text: no value of the profile.
  return redactValues(lines.join('\n'))
}

/**
 * Columns the warehouse returned against those schema.yml documents. Names compare without case, except a
 * column documented with `quote: true` (`quoted`), which the warehouse keeps exactly as written.
 */
export function columnDrift(documented: string[], returned: string[], quoted: string[] = []): { missing: string[]; undocumented: string[] } {
  const has = new Set(returned.map(one => one.toLowerCase()))
  const exact = new Set(quoted)
  const loose = new Set(documented.filter(one => !exact.has(one)).map(one => one.toLowerCase()))
  return {
    missing: documented.filter(one => (exact.has(one) ? !returned.includes(one) : !has.has(one.toLowerCase()))),
    undocumented: returned.filter(one => !loose.has(one.toLowerCase()) && !exact.has(one)),
  }
}

/**
 * Which undocumented columns an edit made, from what the warehouse returned, not from reading the SQL: one the model
 * returned before the edit (`earlier`: the last check's columns, or, on a model's first check, what dbt showed of the
 * model's relation as it was built) is from before; any other is the edit's, as is one an earlier edit in this
 * conversation made and that is still undocumented (`ours`). Names match exactly (a case-sensitive `Amount` is not
 * `amount`). With nothing to compare with, every column is the edit's.
 */
export function undocumentedByEdit(undocumented: string[], earlier: string[] | null, ours: string[] = []): { fresh: string[]; old: string[] } {
  if (earlier === null) return { fresh: undocumented, old: [] }
  const before = new Set(earlier)
  const mine = new Set(ours)
  const old = (name: string) => !mine.has(name) && before.has(name)
  return { fresh: undocumented.filter(one => !old(one)), old: undocumented.filter(old) }
}

// What the history may keep: the plugin store takes 4 MiB of JSON in all, the history and bookmarks among
// other keys, so a cell, a query and the whole history are bounded, in UTF-8 bytes as the store counts them.
const SAVED_CELL = 200
const SAVED_ENTRY_BYTES = 32 * 1024
const HISTORY_BYTES = 2 * 1024 * 1024

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** Rows as the history keeps them: a long cell cut as the table cuts it (marked with …), and no more rows than fit a query's byte budget. */
export function savedRows(rows: unknown[][], limit: number): unknown[][] {
  const cut = (value: unknown) => {
    const text = value === null || value === undefined ? null : typeof value === 'object' ? JSON.stringify(value) : typeof value === 'string' ? value : null
    return text !== null && text.length > SAVED_CELL ? `${text.slice(0, SAVED_CELL - 1)}…` : value
  }
  const kept: unknown[][] = []
  let bytes = 2
  for (const row of rows.slice(0, limit)) {
    const next = row.map(cut)
    // The row's JSON and the comma that joins it.
    bytes += utf8Bytes(JSON.stringify(next)) + 1
    if (bytes > SAVED_ENTRY_BYTES) break
    kept.push(next)
  }
  return kept
}

/** A saved query as a whole, by its serialized UTF-8 size: its error cut, then rows dropped from the end, then columns dropped, until it fits. Its inline SQL is never cut: Re-run executes it, and the history's total budget bounds it. */
export function fitSaved<T extends { rows: unknown[][]; error: string | null; columns?: string[]; inline?: string | null }>(entry: T): T {
  const next = { ...entry, error: entry.error ? entry.error.slice(0, 2000) : entry.error, rows: [...entry.rows] }
  const over = () => utf8Bytes(JSON.stringify(next)) > SAVED_ENTRY_BYTES
  // What cannot be cut (the inline SQL and the query's id, with the error cut above) over the cap by itself: dropping every row and column would not cure it, so they stay, and the history's total budget bounds it.
  if (utf8Bytes(JSON.stringify({ ...next, rows: [], columns: [] })) > SAVED_ENTRY_BYTES) return next
  while (next.rows.length > 0 && over()) next.rows.pop()
  if (over() && next.columns) {
    const columns = [...next.columns]
    while (columns.length > 0 && (next.columns = columns, over())) columns.pop()
  }
  return next
}

/** The history without the entries that were dropped from the store: only the very entries (same id, same time), never a newer run of the same query. */
export function withoutDropped<T extends { id: string; at: number }>(current: T[], dropped: T[]): T[] {
  return current.filter(one => !dropped.some(gone => gone.id === one.id && gone.at === one.at))
}

/** The history without its `count` oldest entries: unbookmarked ones first, bookmarks only when those are gone. The list is newest first. */
export function dropOldest<T extends { bookmarked?: boolean }>(history: T[], count: number): T[] {
  const order = [...history.filter(one => !one.bookmarked).reverse(), ...history.filter(one => one.bookmarked).reverse()]
  const gone = new Set(order.slice(0, count))
  return history.filter(one => !gone.has(one))
}

/** The history within the store's budget for its key: the oldest unbookmarked entries go first, then the oldest bookmarks. */
export function budgetHistory<T extends { bookmarked?: boolean }>(history: T[], limit = HISTORY_BYTES): T[] {
  let kept = history
  while (kept.length > 0 && utf8Bytes(JSON.stringify(kept)) > limit) kept = dropOldest(kept, 1)
  return kept
}

/** A cell as the results table shows it: one line, cut to `width`. */
export function cellText(value: unknown, width: number): string {
  const text = value === null || value === undefined ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const line = text.replace(/\s+/g, ' ')
  return line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line
}

/**
 * Column widths for a results table that fits `columns` characters (each at least 3 wide; a room narrower
 * than that is clipped by the row). The values come first: a value that fits is never cut while a header
 * could give way, and spare room restores cut values first, then grows the headers, one cell at a time.
 */
export function columnWidths(result: Pick<QueryResult, 'columns' | 'rows'>, columns: number): number[] {
  const MIN = 3
  const values = result.columns.map((_, i) => Math.min(200, Math.max(MIN, ...result.rows.slice(0, 50).map(row => cellText(row[i], 200).length))))
  const natural = result.columns.map((name, i) => Math.max(values[i]!, Math.min(200, name.length)))
  const room = Math.max(columns - (natural.length - 1) * 3, natural.length * MIN)
  // Values too wide for the room: the widest give way to one cap that fits.
  const total = (cap: number) => values.reduce((sum, width) => sum + Math.min(width, cap), 0)
  let cap = Math.max(...values)
  while (cap > MIN && total(cap) > room) cap--
  const widths = values.map(width => Math.min(width, cap))
  let spare = room - total(cap)
  // Spare room: values cut by the cap first, then headers.
  for (const limit of [values, natural]) {
    while (spare > 0) {
      let gave = false
      for (let i = 0; i < widths.length && spare > 0; i++) {
        if (widths[i]! < limit[i]!) {
          widths[i]!++
          spare--
          gave = true
        }
      }
      if (!gave) break
    }
  }
  return widths
}
