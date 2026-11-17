// The dbt invocations in a shell command line, as Claude's Bash calls write them: `dbt build -s x`,
// `cd a && dbt run`, `uv run dbt test | tee log`, `DBT_PROFILES_DIR=. dbt run`. Each comes with its
// place in the line, so a caller can rewrite one without touching the rest.
//
// Supported-input contract: parseDbtCommand reports an invocation only when the static text shows dbt
// will start; when in doubt it returns no invocation, and values it cannot read statically are never
// reported as literal values. In particular, these give no invocation:
//   - a line that can't be read (an unclosed quote, substitution or parenthesis, an operator or
//     redirection with nothing after it, a heredoc outside a `$(…)` substitution);
//   - a prefix word with an option outside its grammar. Only these are read: `command -p`, `exec -l`,
//     `exec -a NAME`, `time -p`, and `--` after `command`, `exec`, `nohup` or `env`. So `command -v
//     dbt …` (a lookup), `command --help dbt run`, `nohup --help dbt run`, `exec -c …` and `env -i …`
//     (they clear the environment), `env -u X …` and `time -f …` give none; `env` with only
//     NAME=value words (and `--`) is read;
//   - an option outside the grammar of that launcher's `run` (`uv`, `uvx`, `poetry`, `pipenv`, `pdm`,
//     `hatch`, `rye`; each has its own table): an unknown option may take a value, or print help or a
//     version, so what runs is not known; and a word other than dbt after the launcher's `--`
//     (`uv run -- --project x dbt run`);
//   - a NAME=value word right after `nohup`, `command`, `exec` (it is the command's name, not an
//     assignment), and a quoted NAME=value or quoted shell keyword (`"DBT_TARGET=prod" dbt run`,
//     `"if" dbt run`), which is a command's name too;
//   - a shell keyword other than `time` where it is a program's name, not a keyword: after a prefix
//     command (`env if dbt run`, `nohup ! dbt run`) or after an assignment (`X=1 if dbt run`); and
//     `command` or `exec` (shell builtins) as the program `env` or `nohup` runs;
//   - a backslash as the line's last character;
//   - a binary or subcommand word that holds an expansion (`dbt $CMD`, `$(which dbt) run`);
//   - a redirection among the arguments with another argument after it (`dbt run > log -s a`): an
//     unsupported form, since cutting the invocation out would cut the redirection too. A trailing
//     redirection (`dbt run -s a > log`) is fine and is left out of the invocation's range.
// An expansion is `$(…)`, `${…}`, `$NAME`, `$1`, a backtick command, a `<(…)` / `>(…)` substitution, an
// unquoted `~`, brace list or pathname pattern, or a `$'…'` word with an escape, outside single quotes;
// a word holding one is a single word, whatever it holds.

// Only what is written on the command is read: a DBT_TARGET exported earlier, inherited from the
// session or loaded by a launcher (`uv run --env-file .env`) is not seen, so a null target or target
// path means "none written here", not "none".
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
      // A backslash ending the line escapes nothing the shell can read here; inserting after it would
      // be escaped.
      if (i + 1 >= line.length) return null
      quote()
      text += line[i + 1]!
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
// The options each prefix word has: whether one takes a value. Any other option gives no invocation.
const PREFIX_OPTIONS: Record<string, Record<string, 'flag' | 'value'>> = {
  command: { '-p': 'flag' },
  // `exec -c` clears the environment dbt starts with: what it sees is not known, so it is not read.
  exec: { '-l': 'flag', '-a': 'value' },
  time: { '-p': 'flag' },
}
// Prefix words that end their options at `--`; `time` and the other keywords take no `--`.
const ENDS_AT_DASHES = new Set(['command', 'exec', 'nohup', 'env'])
// Launchers whose `run` subcommand (`uvx`: the launcher itself) runs the command after their own
// options, and the options each one's `run` takes: `flags` take no value, `values` take one. These are
// the only launcher options read: an unknown one may take a value, so which word runs is not known.
const UV_RUN_FLAGS = ['-q', '--quiet', '-v', '--verbose', '--isolated', '--offline', '--refresh', '--native-tls', '--no-config', '--no-cache']
const UV_RUN_VALUES = ['--with', '--with-editable', '--with-requirements', '--python', '-p', '--directory', '--project', '--index', '--index-url', '--env-file']
const RUNNER_OPTIONS: Record<string, { flags: Set<string>; values: Set<string> }> = {
  uv: {
    flags: new Set([
      ...UV_RUN_FLAGS,
      '--no-sync',
      '--frozen',
      '--locked',
      '--active',
      '--no-project',
      '--all-extras',
      '--all-packages',
      '--no-dev',
      '--no-env-file',
      '--exact',
    ]),
    values: new Set([...UV_RUN_VALUES, '--extra', '--group', '--package']),
  },
  uvx: { flags: new Set(UV_RUN_FLAGS), values: new Set([...UV_RUN_VALUES, '--from']) },
  poetry: {
    flags: new Set(['-q', '--quiet', '-v', '--verbose', '-n', '--no-interaction', '--ansi', '--no-ansi', '--no-plugins', '--no-cache']),
    values: new Set(['-P', '--project', '-C', '--directory']),
  },
  pdm: {
    flags: new Set(['-q', '--quiet', '-v', '--verbose', '-g', '--global', '-s', '--site-packages', '--recreate']),
    values: new Set(['-p', '--project', '--venv']),
  },
  rye: { flags: new Set(), values: new Set(['--pyproject']) },
  pipenv: { flags: new Set(), values: new Set() },
  hatch: { flags: new Set(), values: new Set() },
}
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
  return scan(line).map(one => one.invocation)
}

// An invocation with where its `dbt` word is written: leading `VAR=x` words don't move it.
type Found = { invocation: DbtInvocation; at: number }

function scan(line: string): Found[] {
  if (typeof line !== 'string' || !/\bdbt\b/.test(line)) return []
  const tokens = lex(line)
  const notCommand = tokens && readable(tokens)
  if (!tokens || !notCommand) return []
  const found: Found[] = []
  let simple: Token[] = []
  const finish = () => {
    const read = readSimple(simple)
    if (read) found.push({ invocation: read.invocation, at: read.at })
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
      for (const inner of scan(line.slice(shift, token.end - 1))) found.push(moved(inner, shift))
    } else if (token.kind === 'word') {
      // So do the commands of a `$(…)` or backtick substitution in the word, outside single quotes.
      for (const [from, to] of substitutionsIn(line, token.start, token.end)) {
        for (const inner of scan(line.slice(from, to))) found.push(moved(inner, from))
      }
    }
  }
  finish()
  // An inner command (in a substitution) is listed where it is written, not before the command around it.
  return found.sort((a, b) => a.at - b.at)
}

const moved = ({ invocation: i, at }: Found, shift: number): Found => ({
  invocation: { ...i, start: i.start + shift, end: i.end + shift, subcommandEnd: i.subcommandEnd + shift },
  at: at + shift,
})

/** The commands' ranges of the `$(…)` and backtick substitutions written in line[start, end), outside single quotes. */
function substitutionsIn(line: string, start: number, end: number): [number, number][] {
  const found: [number, number][] = []
  // Single quotes hide a substitution; inside double quotes a `'` is a plain character.
  let single = false
  let double = false
  for (let i = start; i < end; i++) {
    const c = line[i]
    if (single) single = c !== "'"
    else if (c === '\\') i++
    else if (c === "'" && !double) single = true
    else if (c === '"') double = !double
    else if ((c === '$' && line[i + 1] === '(') || c === '`') {
      const close = substitutionEnd(line, c === '$' ? i + 1 : i)
      if (close < 0 || close > end) break
      found.push([i + (c === '$' ? 2 : 1), close - 1])
      i = close - 1
    }
  }
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

function readSimple(tokens: Token[]): Found | null {
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
      // After a prefix command or an assignment, a keyword is the name of a program to run (`env if`);
      // only `time` is one that exists (`X=1 time dbt run` runs the external time).
      if (KEYWORDS.has(word.text) && word.text !== 'time' && (wrapped || firstAssignment !== null)) return null
      // `env` and `nohup` run a program: the shell builtins `command` and `exec` are none.
      if ((prefix === 'env' || prefix === 'nohup') && (word.text === 'command' || word.text === 'exec')) return null
      prefix = word.text
      wrapped = WRAPPERS.has(word.text)
      optionsOpen = true
      firstAssignment = null
      continue
    }
    if (unquoted && word.text.startsWith('-') && prefix !== null && optionsOpen) {
      if (word.text === '--' && ENDS_AT_DASHES.has(prefix)) {
        // The next word is the command, or, after `env`, a NAME=value.
        optionsOpen = false
        firstAssignment = null
        continue
      }
      // Only the prefix's own options are read: `command -v` looks dbt up, `env -u X` changes what dbt
      // sees, and `--help` prints usage, so none of them runs dbt as written.
      const takes = PREFIX_OPTIONS[prefix]?.[word.text]
      if (!takes) return null
      if (takes === 'value') i++
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
  } else if (Object.hasOwn(RUNNER_OPTIONS, words[i]!.text.split('/').pop()!)) {
    const runner = words[i]!.text.split('/').pop()!
    i++
    if (runner !== 'uvx') {
      if (words[i]?.text !== 'run') return null
      i++
    }
    while (i < words.length && words[i]!.text.startsWith('-')) {
      const flag = words[i]!.text
      // `uv run --` ends the launcher's options: the next word is the command, whatever it looks like.
      if (flag === '--') {
        i++
        break
      }
      const name = flag.includes('=') ? flag.slice(0, flag.indexOf('=')) : flag
      // An unknown option may take a value, or print help or a version and run nothing.
      const options = RUNNER_OPTIONS[runner]!
      // Repeated short flags (`-qq`, `-vv`) are read when the launcher has the single one.
      const repeated = /^-([a-z])\1+$/.exec(flag)
      if (options.values.has(name)) i += flag.includes('=') ? 1 : 2
      else if (!flag.includes('=') && (options.flags.has(flag) || (repeated && options.flags.has(`-${repeated[1]}`)))) i++
      else return null
    }
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
    at: words[launcherStart]!.start,
    invocation: {
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
    },
  }
}
