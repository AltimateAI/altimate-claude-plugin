// Reading a shell command line as the shell does: its simple commands, and where each one's program starts.
// The push check and the /savings offer both read Bash calls with it.

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
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
/** A shell's long options that take their value as the next word (`--rcfile x`). */
const SHELL_VALUE_OPTIONS = new Set(['--rcfile', '--init-file'])

/**
 * The script a shell runs from its `-c` option (alone or in a cluster: `-lc`, `-cx`, `-Ec`): the first word
 * after the shell's options, where a cluster ending in `o` or `O` (`-o pipefail`, `-euo pipefail`) takes the
 * next word as its value. Null when none of its options is `-c`, so `bash deploy.sh -c x` runs no script
 * here. `at` is where the shell's own name is.
 */
export function shellScript(words: readonly string[], at: number): string | null {
  let script = false
  let i = at + 1
  for (; i < words.length && /^[-+]./.test(words[i]!) && words[i] !== '--'; i++) {
    const word = words[i]!
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) script = true
    if (SHELL_VALUE_OPTIONS.has(word) || /^[-+][A-Za-z]*[oO]$/.test(word)) i++
  }
  if (words[i] === '--') i++
  return script ? (words[i] ?? null) : null
}

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
        if (SHELLS.has(bin) && shellScript(doc.owner, leaderEnd(doc.owner)) === null) nested.push(...simpleCommands(body))
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
export function leaderEnd(words: readonly string[]): number {
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
