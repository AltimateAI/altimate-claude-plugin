// The dbt invocations in a shell command line, as Claude's Bash calls write them: `dbt build -s x`,
// `cd a && dbt run`, `uv run dbt test | tee log`, `DBT_PROFILES_DIR=. dbt run`. Each comes with its
// place in the line, so a caller can rewrite one without touching the rest. A line the lexer can't
// read (an unclosed quote or substitution) yields no invocation.

export type DbtInvocation = {
  /** How dbt is launched, as written: `dbt`, `.venv/bin/dbt`, `uv run dbt`, `poetry run dbt`. */
  binary: string
  /** The first word after the launcher's options: `build`, `run`, `test`…; null when there is none. */
  subcommand: string | null
  /** Every value given to -s, --select, -m, --models or --model, in order. */
  select: string[]
  /** The value of -t or --target; null when not given. */
  target: string | null
  /** The value of --target-path; null when not given. */
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
const REDIRECT = /^(?:\d*(?:>>|>&|>\||>|<&|<<<|<<|<>|<)|&>>?)/

/** Offset just past the `$(…)` or backtick substitution that opens at `at`; -1 when it is not closed. */
function substitutionEnd(line: string, at: number): number {
  if (line[at] === '`') {
    const close = line.indexOf('`', at + 1)
    return close < 0 ? -1 : close + 1
  }
  // `at` is the opening parenthesis: it counts as the first level.
  let depth = 0
  for (let j = at; j < line.length; j++) {
    const c = line[j]
    if (c === '\\') j++
    else if (c === "'") {
      j = line.indexOf("'", j + 1)
      if (j < 0) return -1
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
])
const SELECT_FLAGS = new Set(['-s', '--select', '-m', '--models', '--model'])

const isDbt = (word: string) => word.split('/').pop() === 'dbt'

/** The dbt invocations in a shell command line, in the order written; [] when there are none or the line can't be read. */
export function parseDbtCommand(line: string): DbtInvocation[] {
  if (typeof line !== 'string' || !/\bdbt\b/.test(line)) return []
  const tokens = lex(line)
  if (!tokens) return []
  const found: DbtInvocation[] = []
  let simple: Token[] = []
  const finish = () => {
    const invocation = readSimple(simple)
    if (invocation) found.push(invocation)
    simple = []
  }
  for (const token of tokens) {
    if (token.kind === 'op' && !/[<>]/.test(token.text)) finish()
    else simple.push(token)
  }
  finish()
  return found
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
  for (; i < words.length; i++) {
    const word = words[i]!.text
    if (ASSIGNMENT.test(word)) {
      const name = word.slice(0, word.indexOf('='))
      if (name === 'DBT_DEFER') hasDefer = true
      if (name === 'DBT_STATE' || name === 'DBT_DEFER_STATE') hasState = true
      continue
    }
    if (PREFIX_WORDS.has(word)) continue
    // `env -i`, `time -p`: options of a prefix word.
    if (word.startsWith('-') && i > 0 && PREFIX_WORDS.has(words[i - 1]!.text)) continue
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
      const flag = eq > 0 ? word.slice(0, eq) : word
      const inline = eq > 0 ? word.slice(eq + 1) : null
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
    target,
    targetPath,
    hasDefer,
    hasState,
    start,
    end: words[words.length - 1]!.end,
    subcommandEnd,
  }
}
