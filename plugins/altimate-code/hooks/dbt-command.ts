// The dbt invocations in a shell command line, as Claude's Bash calls write them: `dbt build -s x`,
// `cd a && dbt run`, `uv run dbt test | tee log`, `DBT_PROFILES_DIR=. dbt run`. Each comes with its
// place in the line, so a caller can rewrite one without touching the rest. A line that can't be read
// (an unclosed quote, substitution or parenthesis, an operator or redirection with nothing after it, a
// heredoc outside a `$(…)` substitution) yields no invocation.

export type DbtInvocation = {
  /** How dbt is launched, as written: `dbt`, `.venv/bin/dbt`, `uv run dbt`, `poetry run dbt`. */
  binary: string
  /** The first word after the launcher's options: `build`, `run`, `test`…; null when there is none. */
  subcommand: string | null
  /** Every value given to -s, --select, -m, --models or --model, in order. */
  select: string[]
  /** The value of -t or --target, else of DBT_TARGET set in front of the command; null when neither. */
  target: string | null
  /** The value of --target-path, else of DBT_TARGET_PATH set in front of the command; null when neither. */
  targetPath: string | null
  /** --defer or --no-defer is given, or DBT_DEFER is set in front of the command. */
  hasDefer: boolean
  /** --state or --defer-state is given, or DBT_STATE / DBT_DEFER_STATE is set in front of the command. */
  hasState: boolean
  /** Offset of the invocation's first character (its leading VAR=x assignments included). */
  start: number
  /** Offset just past its last argument (redirections and what follows a pipe excluded). */
  end: number
  /** Offset just past the subcommand (past `binary` when there is none): where flags can be inserted. */
  subcommandEnd: number
}

type Token = { kind: 'word'; text: string; start: number; end: number } | { kind: 'op'; text: string; start: number; end: number }

const OPERATORS = ['&&', '||', ';;', '|&', '|', '&', ';', '(', ')', '\n']
const ARRAY_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/
const REDIRECT = /^(?:\d*(?:>>|>&|>\||>|<&|<<<|<<|<>|<)|&>>?)/

const HEREDOC = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([^\s;&|()<>'"]+))/

/**
 * Offset of the newline that ends a heredoc's closing delimiter line, where `from` is the newline before
 * the body; -1 when the delimiter never comes or nothing follows it.
 */
function heredocBodyEnd(line: string, from: number, delimiter: string, strip: boolean): number {
  for (let at = from + 1; ; ) {
    const eol = line.indexOf('\n', at)
    if (eol < 0) return -1
    const row = line.slice(at, eol)
    if ((strip ? row.replace(/^\t+/, '') : row) === delimiter) return eol
    at = eol + 1
  }
}

/** Offset just past the `$(…)` or backtick substitution that opens at `at`; -1 when it is not closed. */
function substitutionEnd(line: string, at: number): number {
  if (line[at] === '`') {
    const close = line.indexOf('`', at + 1)
    return close < 0 ? -1 : close + 1
  }
  // `at` is the opening parenthesis: it counts as the first level.
  let depth = 0
  // Heredocs opened on the line being read; their bodies start on the next line.
  const heredocs: { delimiter: string; strip: boolean }[] = []
  for (let j = at; j < line.length; j++) {
    const c = line[j]
    if (c === '\n' && heredocs.length) {
      for (const { delimiter, strip } of heredocs.splice(0)) {
        j = heredocBodyEnd(line, j, delimiter, strip)
        if (j < 0) return -1
      }
    } else if (c === '<' && line[j + 1] === '<' && line[j + 2] === '<') {
      // A here-string: its word is read as ordinary text, and its `<<` is no heredoc.
      j += 2
    } else if (c === '<' && line[j + 1] === '<') {
      // A heredoc's body is text: its quotes and parentheses are not read.
      const heredoc = HEREDOC.exec(line.slice(j))
      if (heredoc) {
        heredocs.push({ delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[4]!, strip: heredoc[1] === '-' })
        j += heredoc[0].length - 1
      }
    } else if (c === '\\') j++
    else if (c === "'") {
      j = line.indexOf("'", j + 1)
      if (j < 0) return -1
    } else if (c === '"') {
      // A double-quoted string: its parentheses are text, but a substitution inside it still nests.
      for (j++; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\') j++
        else if (line[j] === '$' && line[j + 1] === '(') {
          const end = substitutionEnd(line, j + 1)
          if (end < 0) return -1
          j = end - 1
        }
      }
      if (j >= line.length) return -1
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j + 1
  }
  return -1
}

/** The words and operators of a command line, with their offsets; null when a quote or substitution is not closed. */
function lex(line: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  let text = ''
  let start = -1
  const flush = (end: number) => {
    if (start >= 0) tokens.push({ kind: 'word', text, start, end })
    text = ''
    start = -1
  }
  while (i < line.length) {
    const c = line[i]!
    if (c === '\\' && line[i + 1] === '\n') {
      i += 2
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flush(i)
      i++
      continue
    }
    if (c === '#' && start < 0) {
      while (i < line.length && line[i] !== '\n') i++
      continue
    }
    // `<(…)` and `>(…)` (process substitution), `((…))` (arithmetic) and the `(…)` of `name=(…)` (an
    // array) are one word, up to the matching parenthesis.
    const paren =
      (c === '<' || c === '>') && line[i + 1] === '(' && start < 0
        ? i + 1
        : c === '(' && (start < 0 ? line[i + 1] === '(' : ARRAY_ASSIGNMENT.test(text))
          ? i
          : -1
    if (paren >= 0) {
      const end = substitutionEnd(line, paren)
      if (end < 0) return null
      if (start < 0) start = i
      text += line.slice(i, end)
      i = end
      continue
    }
    const redirect = REDIRECT.exec(line.slice(i))
    if (redirect && (start < 0 || !/^\d/.test(redirect[0]))) {
      flush(i)
      tokens.push({ kind: 'op', text: redirect[0], start: i, end: i + redirect[0].length })
      i += redirect[0].length
      continue
    }
    const op = OPERATORS.find(one => line.startsWith(one, i))
    if (op) {
      flush(i)
      tokens.push({ kind: 'op', text: op, start: i, end: i + op.length })
      i += op.length
      continue
    }
    if (start < 0) start = i
    if (c === '\\') {
      text += line[i + 1] ?? ''
      i += 2
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1)
      if (close < 0) return null
      text += line.slice(i + 1, close)
      i = close + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) {
          text += line[j + 1]
          j += 2
        } else if ((line[j] === '$' && line[j + 1] === '(') || line[j] === '`') {
          const end = substitutionEnd(line, line[j] === '$' ? j + 1 : j)
          if (end < 0) return null
          text += line.slice(j, end)
          j = end
        } else text += line[j++]
      }
      if (j >= line.length) return null
      i = j + 1
    } else if ((c === '$' && line[i + 1] === '(') || c === '`') {
      const end = substitutionEnd(line, c === '$' ? i + 1 : i)
      if (end < 0) return null
      text += line.slice(i, end)
      i = end
    } else {
      text += c
      i++
    }
  }
  flush(i)
  return tokens
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Words that may stand in front of a command without being it.
const PREFIX_WORDS = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'command', 'exec', 'nohup', 'env'])
// Options of those prefix words that take a value, so the value is not read as the command.
const PREFIX_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir', '-f', '--format', '-o', '--output', '-a'])
// Launchers whose `run` subcommand runs the command after their own options.
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye', 'uvx'])
// Launcher options that take a value, so the value is not read as the command.
const RUNNER_VALUE_FLAGS = new Set([
  '--with',
  '--with-editable',
  '--with-requirements',
  '--project',
  '--directory',
  '--python',
  '-p',
  '--env-file',
  '--extra',
  '--group',
  '--package',
  '--index',
  '--index-url',
  '--from',
  '-e',
  '--env',
  '-C',
])
// dbt options that take a value, so the value is not read as the subcommand or as a selector.
const DBT_VALUE_FLAGS = new Set([
  '--log-format',
  '--log-format-file',
  '--log-level',
  '--log-level-file',
  '--log-path',
  '--profiles-dir',
  '--project-dir',
  '--profile',
  '--target',
  '-t',
  '--target-path',
  '--vars',
  '--state',
  '--defer-state',
  '--threads',
  '--printer-width',
  '--exclude',
  '--selector',
  '--resource-type',
  '--resource-types',
  '--exclude-resource-type',
  '--exclude-resource-types',
  '--output',
  '-o',
  '--output-keys',
  '--inline',
  '--limit',
  '--args',
  '--macro',
  '--warn-error-options',
  '--record-timing-info',
  '-r',
  '--indirect-selection',
  '--event-time-start',
  '--event-time-end',
  '--sample',
  '--log-file-max-bytes',
  '--add-package',
  '--source',
])
// Short dbt options that take a value, which may also be written joined to it: `-tprod`, `-sorders`.
const SHORT_VALUE_FLAGS = new Set(['-s', '-m', '-t', '-o', '-r'])
const SELECT_FLAGS = new Set(['-s', '--select', '-m', '--models', '--model'])

const isDbt = (word: string) => word.split('/').pop() === 'dbt'

/** The dbt invocations in a shell command line, in the order written; [] when there are none or the line can't be read. */
export function parseDbtCommand(line: string): DbtInvocation[] {
  if (typeof line !== 'string' || !/\bdbt\b/.test(line)) return []
  const tokens = lex(line)
  const notCommand = tokens && readable(tokens)
  if (!tokens || !notCommand) return []
  const found: DbtInvocation[] = []
  let simple: Token[] = []
  const finish = () => {
    const invocation = readSimple(simple)
    if (invocation) found.push(invocation)
    simple = []
  }
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!
    if (notCommand.has(k)) continue
    if (token.kind === 'op' && !/[<>]/.test(token.text)) finish()
    else simple.push(token)
    // The commands of a process substitution (`<(…)`, `>(…)`) run too: they are read as a line of their own.
    if (token.kind === 'word' && /^[<>]\(/.test(line.slice(token.start, token.end))) {
      const shift = token.start + 2
      for (const inner of parseDbtCommand(line.slice(shift, token.end - 1)))
        found.push({ ...inner, start: inner.start + shift, end: inner.end + shift, subcommandEnd: inner.subcommandEnd + shift })
    }
  }
  finish()
  return found
}

const isRedirect = (token: Token) => token.kind === 'op' && /[<>]/.test(token.text)

// Words after which a command still starts, so a `(` there opens a subshell.
const COMMAND_KEYWORDS = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time'])
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * Which words are not part of a command (`case` patterns, function names) when the tokens make a command
 * line the shell would run; null when they don't. A line the shell would run is one where every
 * redirection has a target, every `&&`, `||` and pipe has a command on both sides, `;` and `&` follow a command, parentheses pair up
 * (subshells, `name()` function definitions, `case` patterns), and a `case` reaches its `esac`. A
 * heredoc counts as unreadable, since its body lines are text, not commands (one inside `$(…)` is skipped
 * when the substitution is read).
 */
function readable(tokens: Token[]): Set<number> | null {
  // Indices of words that are not part of a command: `case` patterns and function names.
  const notCommand = new Set<number>()
  // Open subshells and `case` statements, innermost last.
  const open: ('(' | 'case')[] = []
  // Words of the command being read, its leading keywords not counted; whether an operator still waits
  // for a command; whether a `case` pattern is being read, up to its `)`; and how far a `case` head
  // (`case WORD in`) has been read.
  let words: string[] = []
  let waiting = false
  let pattern = false
  let caseHead: 'none' | 'case' | 'word' = 'none'
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]!
    if (token.kind === 'word') {
      waiting = false
      if (caseHead === 'case') caseHead = 'word'
      else if (caseHead === 'word') {
        if (token.text !== 'in') return null
        caseHead = 'none'
        pattern = true
      } else if (!words.length && token.text === 'esac' && open.at(-1) === 'case') {
        open.pop()
        pattern = false
        words = [token.text]
      } else if (pattern) {
        words.push(token.text)
        notCommand.add(k)
      }
      else if (!words.length && token.text === 'case') {
        open.push('case')
        caseHead = 'case'
      } else if (words.length || !COMMAND_KEYWORDS.has(token.text)) words.push(token.text)
      continue
    }
    if (isRedirect(token)) {
      if (/^\d*<<$/.test(token.text)) return null
      if (tokens[k + 1]?.kind !== 'word') return null
      // The target is not the command's word, but a redirection alone is a command (`> out`).
      k++
      words.push(token.text)
      waiting = false
      continue
    }
    if (caseHead !== 'none' && token.text !== '\n') return null
    switch (token.text) {
      case '\n':
        if (!waiting && !pattern) words = []
        continue
      case '(':
        // A pattern may open with `(`; where a command starts, `(` opens a subshell; after one name it
        // defines a function, whose body follows.
        if (pattern && !words.length) continue
        if (!words.length) open.push('(')
        else if (
          tokens[k + 1]?.text === ')' &&
          NAME.test(words.at(-1)!) &&
          (words.length === 1 || (words.length === 2 && words[0] === 'function'))
        ) {
          notCommand.add(k - 1)
          if (words.length === 2) notCommand.add(k - 2)
          k++
          words = []
        } else return null
        continue
      case ')':
        if (pattern) {
          if (!words.length) return null
          pattern = false
          words = []
          continue
        }
        if (open.at(-1) !== '(' || waiting) return null
        open.pop()
        words = [token.text]
        continue
      case ';;':
        if (open.at(-1) !== 'case' || pattern) return null
        words = []
        pattern = true
        continue
      case '|':
        // Alternatives in a pattern.
        if (pattern) {
          if (!words.length) return null
          words = []
          continue
        }
      // falls through
      case '&&':
      case '||':
      case '|&':
        if (!words.length || pattern) return null
        words = []
        waiting = true
        continue
      default:
        // `;` and `&` end the command before them.
        if (!words.length || pattern) return null
        words = []
    }
  }
  return !open.length && !waiting && !pattern && caseHead === 'none' ? notCommand : null
}

function readSimple(tokens: Token[]): DbtInvocation | null {
  // Drop redirections and their targets: what is left is the command's words.
  const words: Extract<Token, { kind: 'word' }>[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'op') {
      // A redirection takes the next word as its target (`> log`, `2>&1`).
      i++
      continue
    }
    words.push(token)
  }
  if (words.length === 0) return null
  const start = words[0]!.start
  let i = 0
  let hasDefer = false
  let hasState = false
  let envTarget: string | null = null
  let envTargetPath: string | null = null
  // The prefix word whose options are being read (`env -u X`, `time -p`).
  let prefix: string | null = null
  for (; i < words.length; i++) {
    const word = words[i]!.text
    if (ASSIGNMENT.test(word)) {
      const name = word.slice(0, word.indexOf('='))
      const assigned = word.slice(word.indexOf('=') + 1)
      if (name === 'DBT_DEFER') hasDefer = true
      if (name === 'DBT_STATE' || name === 'DBT_DEFER_STATE') hasState = true
      if (name === 'DBT_TARGET') envTarget = assigned
      if (name === 'DBT_TARGET_PATH') envTargetPath = assigned
      prefix = null
      continue
    }
    if (PREFIX_WORDS.has(word)) {
      prefix = word
      continue
    }
    if (word.startsWith('-') && prefix !== null) {
      if (PREFIX_VALUE_FLAGS.has(word)) i++
      continue
    }
    break
  }
  if (i >= words.length) return null
  const launcherStart = i
  let binaryEnd: number
  if (isDbt(words[i]!.text)) {
    binaryEnd = i
  } else if (RUNNERS.has(words[i]!.text.split('/').pop()!)) {
    const runner = words[i]!.text.split('/').pop()!
    i++
    if (runner !== 'uvx') {
      if (words[i]?.text !== 'run') return null
      i++
    }
    while (i < words.length && words[i]!.text.startsWith('-')) {
      const flag = words[i]!.text
      i += RUNNER_VALUE_FLAGS.has(flag) && !flag.includes('=') ? 2 : 1
    }
    // `uv run --` ends the launcher's options.
    if (words[i]?.text === '--') i++
    if (i >= words.length || !isDbt(words[i]!.text)) return null
    binaryEnd = i
  } else return null

  const binary = words
    .slice(launcherStart, binaryEnd + 1)
    .map(one => one.text)
    .join(' ')
  let subcommand: string | null = null
  let subcommandEnd = words[binaryEnd]!.end
  const select: string[] = []
  let target: string | null = null
  let targetPath: string | null = null
  let selecting = false
  for (let j = binaryEnd + 1; j < words.length; j++) {
    const word = words[j]!.text
    if (word.startsWith('-')) {
      selecting = false
      const eq = word.indexOf('=')
      const joined = !word.startsWith('--') && word.length > 2 && SHORT_VALUE_FLAGS.has(word.slice(0, 2))
      const flag = joined ? word.slice(0, 2) : eq > 0 ? word.slice(0, eq) : word
      const inline = joined ? word.slice(2) : eq > 0 ? word.slice(eq + 1) : null
      const value = () => {
        if (inline !== null) return inline
        j++
        return words[j]?.text ?? null
      }
      if (SELECT_FLAGS.has(flag)) {
        if (inline !== null) select.push(...inline.split(/\s+/).filter(Boolean))
        selecting = true
      } else if (flag === '-t' || flag === '--target') target = value()
      else if (flag === '--target-path') targetPath = value()
      else if (flag === '--defer' || flag === '--no-defer') hasDefer = true
      else if (flag === '--state' || flag === '--defer-state') {
        hasState = true
        value()
      } else if (DBT_VALUE_FLAGS.has(flag) && inline === null) j++
      continue
    }
    if (selecting) {
      select.push(...word.split(/\s+/).filter(Boolean))
      continue
    }
    if (subcommand === null) {
      subcommand = word
      subcommandEnd = words[j]!.end
    }
  }
  return {
    binary,
    subcommand,
    select,
    target: target ?? envTarget,
    targetPath: targetPath ?? envTargetPath,
    hasDefer,
    hasState,
    start,
    end: words[words.length - 1]!.end,
    subcommandEnd,
  }
}
