// The dbt invocations in a shell command line, as Claude's Bash calls write them: `dbt build -s x`,
// `cd a && dbt run`, `uv run dbt test | tee log`, `DBT_PROFILES_DIR=. dbt run`. Each comes with its
// place in the line, so a caller can rewrite one without touching the rest.
//
// Supported-input contract: parseDbtCommand reports an invocation only when the static text shows dbt
// will start; when in doubt it returns no invocation, and values it cannot read statically are never
// reported as literal values. In particular, these give no invocation:
//   - a line that can't be read (an unclosed quote, substitution or parenthesis, an operator or
//     redirection with nothing after it, a heredoc outside a `$(…)` substitution);
//   - `command -v dbt …` / `command -V dbt …` (a lookup), and `env` followed by any option word
//     (`env -u X`, `env -i`, `env -S`); `env` with only NAME=value words is read;
//   - a NAME=value word right after `nohup`, `command`, `exec` (it is the command's name, not an
//     assignment), and a quoted NAME=value or quoted shell keyword (`"DBT_TARGET=prod" dbt run`,
//     `"if" dbt run`), which is a command's name too;
//   - a binary or subcommand word that holds an expansion (`dbt $CMD`, `$(which dbt) run`);
//   - a redirection among the arguments with another argument after it (`dbt run > log -s a`): an
//     unsupported form, since cutting the invocation out would cut the redirection too. A trailing
//     redirection (`dbt run -s a > log`) is fine and is left out of the invocation's range.
// An expansion is `$(…)`, `${…}`, `$NAME`, `$1`, a backtick command, a `<(…)` / `>(…)` substitution, an
// unquoted `~`, brace list or pathname pattern, or a `$'…'` word with an escape, outside single quotes;
// a word holding one is a single word, whatever it holds.

export type DbtInvocation = {
  /** How dbt is launched, as written: `dbt`, `.venv/bin/dbt`, `uv run dbt`, `poetry run dbt`. */
  binary: string
  /** The first known dbt subcommand after the launcher's options (`build`, `run`, `test`…); else the first other word; null when there is none. */
  subcommand: string | null
  /**
   * Every value given to -s, --select, -m, --models or --model, in order. A value that holds an expansion
   * is left out, so when `dynamic` is true this list is unknown, not complete.
   */
  select: string[]
  /**
   * The value of -t or --target, else of DBT_TARGET set in front of the command; null when neither, and
   * null when the value holds an expansion. When `dynamic` is true it is unknown, not "none".
   */
  target: string | null
  /**
   * The value of --target-path, else of DBT_TARGET_PATH set in front of the command; null when neither,
   * and null when the value holds an expansion. When `dynamic` is true it is unknown, not "none".
   */
  targetPath: string | null
  /**
   * Some word of the invocation (its leading assignments, launcher, flags or flag values) holds an
   * expansion, so what the shell passes to dbt is not what the text says. A consumer treats `select`,
   * `target` and `targetPath` of such an invocation as unknown, and does not rewrite it on their strength.
   */
  dynamic: boolean
  /** --defer or --no-defer is given, or DBT_DEFER is set in front of the command. */
  hasDefer: boolean
  /** --state or --defer-state is given, or DBT_STATE / DBT_DEFER_STATE is set in front of the command. */
  hasState: boolean
  /**
   * Offset of the invocation's first character: its leading VAR=x assignments included, the shell
   * keywords and prefix commands in front of them (`if`, `then`, `!`, `time`, `nohup`, `env` and its
   * options) not, so `line.slice(start, end)` can be replaced without breaking what surrounds it.
   */
  start: number
  /** Offset just past its last argument (redirections and what follows a pipe excluded). */
  end: number
  /** Offset just past the subcommand (past `binary` when there is none): where flags can be inserted. */
  subcommandEnd: number
}

type Word = {
  kind: 'word'
  text: string
  start: number
  end: number
  /**
   * Where in `text` the first quoted part (single, double, `$'…'` or a backslash escape) begins; -1 when
   * no part is quoted. A NAME=value word is an assignment only when its `=` comes before it.
   */
  quotedAt: number
  /** An expansion outside single quotes, or a `$'…'` holding an escape: `$(…)`, `${…}`, `$NAME`, `$1`, a backtick command, `<(…)`, `~/x`, `{a,b}`, `*.sql`. */
  dynamic: boolean
}
type Token = Word | { kind: 'op'; text: string; start: number; end: number }

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

/** Offset just past the `${…}` whose `{` is at `at`; -1 when it is not closed. */
function braceEnd(line: string, at: number): number {
  let depth = 0
  for (let j = at; j < line.length; j++) {
    const c = line[j]
    if (c === '\\') j++
    else if (c === "'") {
      j = line.indexOf("'", j + 1)
      if (j < 0) return -1
    } else if (c === '"') {
      for (j++; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\') j++
        else if (line[j] === '$' && line[j + 1] === '(') {
          const end = substitutionEnd(line, j + 1)
          if (end < 0) return -1
          j = end - 1
        }
      }
      if (j >= line.length) return -1
    } else if (c === '$' && line[j + 1] === '(') {
      const end = substitutionEnd(line, j + 1)
      if (end < 0) return -1
      j = end - 1
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return j + 1
  }
  return -1
}

/** A `$` that opens a variable: a name, a digit or one of the special parameters. */
const startsVariable = (next: string | undefined) => next !== undefined && /[A-Za-z0-9_@*#?!$-]/.test(next)

/** The words and operators of a command line, with their offsets; null when a quote or substitution is not closed. */
function lex(line: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  let text = ''
  let start = -1
  let quotedAt = -1
  let dynamic = false
  const flush = (end: number) => {
    if (start >= 0) tokens.push({ kind: 'word', text, start, end, quotedAt, dynamic })
    text = ''
    start = -1
    quotedAt = -1
    dynamic = false
  }
  // A quoted part is about to add to `text`.
  const quote = () => {
    if (quotedAt < 0) quotedAt = text.length
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
        : c === '(' && (start < 0 ? line[i + 1] === '(' : quotedAt < 0 && ARRAY_ASSIGNMENT.test(text))
          ? i
          : -1
    if (paren >= 0) {
      const end = substitutionEnd(line, paren)
      if (end < 0) return null
      if (start < 0) start = i
      // A process substitution's value is a path the shell makes up.
      if (c === '<' || c === '>') dynamic = true
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
      quote()
      text += line[i + 1] ?? ''
      i += 2
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1)
      if (close < 0) return null
      quote()
      text += line.slice(i + 1, close)
      i = close + 1
    } else if (c === '$' && line[i + 1] === "'") {
      // `$'…'`: a quoted string in which a backslash escapes the next character. Escapes (`\x64`, `\n`)
      // are not decoded here, so a word that holds one is dynamic and its value is not reported.
      let j = i + 2
      while (j < line.length && line[j] !== "'") j += line[j] === '\\' ? 2 : 1
      if (j >= line.length) return null
      quote()
      const body = line.slice(i + 2, j)
      if (body.includes('\\')) dynamic = true
      text += body
      i = j + 1
    } else if (c === '$' && line[i + 1] === '"') {
      // `$"…"` is a double-quoted string: the `$` is not part of the word.
      i++
    } else if (c === '"') {
      quote()
      let j = i + 1
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) {
          // Inside double quotes a backslash only escapes `$`, a backtick, `"`, `\` and a newline.
          const next = line[j + 1] ?? ''
          if (next === '\n') {
            // line continuation: nothing is added
          } else if ('$`"\\'.includes(next)) text += next
          else text += '\\' + next
          j += 2
        } else if ((line[j] === '$' && line[j + 1] === '(') || line[j] === '`') {
          const end = substitutionEnd(line, line[j] === '$' ? j + 1 : j)
          if (end < 0) return null
          dynamic = true
          text += line.slice(j, end)
          j = end
        } else if (line[j] === '$' && line[j + 1] === '{') {
          const end = braceEnd(line, j + 1)
          if (end < 0) return null
          dynamic = true
          text += line.slice(j, end)
          j = end
        } else {
          if (line[j] === '$' && startsVariable(line[j + 1])) dynamic = true
          text += line[j++]
        }
      }
      if (j >= line.length) return null
      i = j + 1
    } else if ((c === '$' && line[i + 1] === '(') || c === '`') {
      const end = substitutionEnd(line, c === '$' ? i + 1 : i)
      if (end < 0) return null
      dynamic = true
      text += line.slice(i, end)
      i = end
    } else if (c === '$' && line[i + 1] === '{') {
      const end = braceEnd(line, i + 1)
      if (end < 0) return null
      dynamic = true
      text += line.slice(i, end)
      i = end
    } else {
      if (c === '$' && startsVariable(line[i + 1])) dynamic = true
      // The shell expands these before dbt sees them: a home directory, a brace list, a pathname pattern.
      if (c === '*' || c === '?' || c === '[') dynamic = true
      // (also after the `=` of a NAME=value word, but not after a flag's `=`)
      if (c === '~' && (i === start || /^[A-Za-z_][A-Za-z0-9_]*=$/.test(line.slice(start, i)))) dynamic = true
      if (c === '{' && /^\{[^}]*(,|\.\.)[^}]*\}/.test(line.slice(i))) dynamic = true
      text += c
      i++
    }
  }
  flush(i)
  return tokens
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Shell keywords after which a command still starts: assignments may follow them.
const KEYWORDS = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time'])
// Commands that run their first argument that is no option: a NAME=value there is the command's name.
const WRAPPERS = new Set(['command', 'exec', 'nohup', 'env'])
// Options of those words and of `time` that take a value, so the value is not read as the command.
const PREFIX_VALUE_FLAGS = new Set(['-C', '--chdir', '-f', '--format', '-o', '--output', '-a'])
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
  '--partial-parse-file-path',
  '--packages-install-path',
])
// Short dbt options that take a value, which may also be written joined to it: `-tprod`, `-sorders`.
const SHORT_VALUE_FLAGS = new Set(['-s', '-m', '-t', '-o', '-r'])
const SELECT_FLAGS = new Set(['-s', '--select', '-m', '--models', '--model'])

// dbt's subcommands: the first of these in the line is the one dbt runs.
const DBT_SUBCOMMANDS = new Set([
  'build',
  'clean',
  'clone',
  'compile',
  'debug',
  'deps',
  'docs',
  'init',
  'list',
  'ls',
  'parse',
  'retry',
  'run',
  'run-operation',
  'seed',
  'show',
  'snapshot',
  'source',
  'test',
])

const isDbt = (word: string) => word.split('/').pop() === 'dbt'

/** Whether `word` is a NAME=value assignment: a quoted part may only come after the `=`. */
const isAssignment = (word: Word) => ASSIGNMENT.test(word.text) && (word.quotedAt < 0 || word.text.indexOf('=') < word.quotedAt)

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
      // A quoted word is never a keyword.
      const word = token.quotedAt >= 0 ? `\u0000${token.text}` : token.text
      if (caseHead === 'case') caseHead = 'word'
      else if (caseHead === 'word') {
        if (word !== 'in') return null
        caseHead = 'none'
        pattern = true
      } else if (!words.length && word === 'esac' && open.at(-1) === 'case') {
        open.pop()
        pattern = false
        words = [token.text]
      } else if (pattern) {
        words.push(token.text)
        notCommand.add(k)
      }
      else if (!words.length && word === 'case') {
        open.push('case')
        caseHead = 'case'
      } else if (words.length || !COMMAND_KEYWORDS.has(word)) words.push(token.text)
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
  const words: Word[] = []
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
  // The first of the assignments right in front of the launcher; prefix words reset it.
  let firstAssignment: number | null = null
  let i = 0
  let hasDefer = false
  let hasState = false
  let envTarget: string | null = null
  let envTargetPath: string | null = null
  // Whether any assignment dbt is given holds an expansion; prefix words do not clear it.
  let assignmentDynamic = false
  // The prefix word whose options are being read (`env -u X`, `time -p`); whether it is a wrapper, after
  // which the next word that is no option is the command itself.
  let prefix: string | null = null
  let wrapped = false
  // Whether the prefix word's options may still come: not after an assignment.
  let optionsOpen = false
  for (; i < words.length; i++) {
    const word = words[i]!
    if (isAssignment(word)) {
      // After `nohup`, `command` or `exec` this is the name of the command to run, not an assignment.
      if (wrapped && prefix !== 'env') return null
      const name = word.text.slice(0, word.text.indexOf('='))
      const assigned = word.dynamic ? null : word.text.slice(word.text.indexOf('=') + 1)
      if (name === 'DBT_DEFER') hasDefer = true
      if (name === 'DBT_STATE' || name === 'DBT_DEFER_STATE') hasState = true
      if (name === 'DBT_TARGET') envTarget = assigned
      if (name === 'DBT_TARGET_PATH') envTargetPath = assigned
      if (word.dynamic) assignmentDynamic = true
      firstAssignment ??= i
      optionsOpen = false
      continue
    }
    // A quoted word is a command's name, never a keyword or a prefix command.
    const unquoted = word.quotedAt < 0
    if (unquoted && (KEYWORDS.has(word.text) || WRAPPERS.has(word.text))) {
      prefix = word.text
      wrapped = WRAPPERS.has(word.text)
      optionsOpen = true
      firstAssignment = null
      continue
    }
    if (unquoted && word.text.startsWith('-') && prefix !== null && optionsOpen) {
      // `env` with an option (`-u X`, `-i`, `-S …`) may clear or change what dbt sees: not read.
      if (prefix === 'env') return null
      // `command -v dbt` and `command -V dbt` look the command up; they do not run it.
      if (prefix === 'command' && /^-[A-Za-z]*[vV]/.test(word.text)) return null
      if (PREFIX_VALUE_FLAGS.has(word.text)) i++
      firstAssignment = null
      continue
    }
    break
  }
  if (i >= words.length) return null
  const start = words[firstAssignment ?? i]!.start
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
      // The launcher prints its help or version and runs nothing.
      if (flag === '-h' || flag === '--help' || flag === '-V' || flag === '--version') return null
      i += RUNNER_VALUE_FLAGS.has(flag) && !flag.includes('=') ? 2 : 1
    }
    // `uv run --` ends the launcher's options.
    if (words[i]?.text === '--') i++
    if (i >= words.length || !isDbt(words[i]!.text)) return null
    binaryEnd = i
  } else return null
  // A binary that holds an expansion is not known to be dbt.
  if (words[binaryEnd]!.dynamic) return null
  const end = words[words.length - 1]!.end
  // A redirection among the arguments, with an argument after it, would be cut out with the invocation.
  if (tokens.some(token => token.kind === 'op' && token.start > start && token.start < end)) return null

  const binary = words
    .slice(launcherStart, binaryEnd + 1)
    .map(one => one.text)
    .join(' ')
  let subcommand: string | null = null
  let subcommandEnd = words[binaryEnd]!.end
  // The first word that is no option, used when none is a known subcommand.
  let firstOther: Word | null = null
  const select: string[] = []
  let target: string | null = null
  let targetPath: string | null = null
  // A target or target path given by a value that holds an expansion: unknown, so null whatever else says.
  let targetDynamic = false
  let targetPathDynamic = false
  let selecting = false
  for (let j = binaryEnd + 1; j < words.length; j++) {
    const current = words[j]!
    const word = current.text
    if (word.startsWith('-')) {
      selecting = false
      const eq = word.indexOf('=')
      const joined = !word.startsWith('--') && word.length > 2 && SHORT_VALUE_FLAGS.has(word.slice(0, 2))
      const flag = joined ? word.slice(0, 2) : eq > 0 ? word.slice(0, eq) : word
      const inline = joined ? word.slice(2) : eq > 0 ? word.slice(eq + 1) : null
      // The flag's value and whether it holds an expansion (null value: none given).
      const value = (): { text: string | null; dynamic: boolean } => {
        if (inline !== null) return { text: inline, dynamic: current.dynamic }
        j++
        return { text: words[j]?.text ?? null, dynamic: words[j]?.dynamic ?? false }
      }
      if (SELECT_FLAGS.has(flag)) {
        if (inline !== null && !current.dynamic) select.push(...inline.split(/\s+/).filter(Boolean))
        selecting = true
      } else if (flag === '-t' || flag === '--target') {
        const given = value()
        target = given.dynamic ? null : given.text
        targetDynamic = given.dynamic
      } else if (flag === '--target-path') {
        const given = value()
        targetPath = given.dynamic ? null : given.text
        targetPathDynamic = given.dynamic
      } else if (flag === '--defer' || flag === '--no-defer') hasDefer = true
      else if (flag === '--state' || flag === '--defer-state') {
        hasState = true
        value()
      } else if (DBT_VALUE_FLAGS.has(flag) && inline === null) j++
      continue
    }
    if (selecting) {
      if (!current.dynamic) select.push(...word.split(/\s+/).filter(Boolean))
      continue
    }
    if (subcommand === null) {
      // Which word dbt takes as the subcommand is not known when an expansion may be it.
      if (current.dynamic) return null
      if (DBT_SUBCOMMANDS.has(word)) {
        subcommand = word
        subcommandEnd = current.end
      } else firstOther ??= current
    }
  }
  if (subcommand === null && firstOther) {
    subcommand = firstOther.text
    subcommandEnd = firstOther.end
  }
  return {
    binary,
    subcommand,
    select,
    target: targetDynamic ? null : (target ?? envTarget),
    targetPath: targetPathDynamic ? null : (targetPath ?? envTargetPath),
    dynamic: assignmentDynamic || words.slice(firstAssignment ?? launcherStart).some(one => one.dynamic),
    hasDefer,
    hasState,
    start,
    end,
    subcommandEnd,
  }
}
