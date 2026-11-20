// What /feedback may attach, kept apart from feedback.ts so the dbt helpers can record into it without importing it: the
// last plugin error (in memory only) and the versions the dbt doctor found.
// The last plugin error is never kept as text. An error's message can hold a path, SQL, a relation, model or column name or a
// secret, in any form, so only what a fixed list recognises is taken out of it at once: the error's type, an errno or SQLSTATE code,
// the plugin's own host-call names (`$.process.run`), and a few fixed phrases. Nothing else of the message is kept, so nothing
// else can be filed.
const KNOWN_TOKENS = [
  String.raw`\b(?:Compilation|Database|Runtime|Parsing|Dependency|Configuration) Error\b`,
  String.raw`\b(?:Type|Range|Syntax|Reference|Hooks|Eval|URI)Error\b`,
  String.raw`\bE(?:NOENT|ACCES|PERM|EXIST|NOTDIR|ISDIR|TIMEDOUT|CONNREFUSED|CONNRESET|PIPE|MFILE|NOTEMPTY|AGAIN)\b`,
  String.raw`\b\d{5,6} \([0-9A-Z]{5}\)`,
  String.raw`\bSQLSTATE[ =:]*[0-9A-Z]{5}\b`,
  String.raw`\$\.(?:command\.(?:register|run)|process\.run|session\.(?:start|end|info|version|id|root|cwd|send)|ui\.(?:render|toast|log|open|status|resolve)|fs\.(?:read|write|exists|stat|list)|env\.get|store\.(?:get|set)|state\.(?:get|set)|prompt\.submit|clock\.(?:now|sleep))(?![\w])`,
  String.raw`\b(?:[Tt]imed out|[Nn]ot found|no implementation|[Pp]ermission denied|[Cc]onnection refused|[Nn]ot authorized|does not exist|[Ss]yntax error|SQL compilation error|could not be parsed|failed to start)\b`,
]
const KNOWN = new RegExp(KNOWN_TOKENS.join('|'), 'g')
const MAX_TOKENS = 8

/** What a fixed list recognises in an error's text, in order, each once; never any other part of the text. */
export function errorKinds(text: string): string {
  const found: string[] = []
  for (const match of String(text).slice(0, 20_000).matchAll(KNOWN)) {
    const kind = match[0]
    if (!found.includes(kind)) found.push(kind)
    if (found.length >= MAX_TOKENS) break
  }
  return found.join(', ')
}

let lastProblem: { source: string; text: string } | null = null

/**
 * Remembers the last plugin error, in memory only, for `--with-error`: `source` is the plugin's own words ("dbt run failed"),
 * and of `raw` only what `errorKinds` recognises is kept.
 */
export function noteProblem(source: string, raw: string): void {
  lastProblem = { source: source.slice(0, 80), text: errorKinds(raw) || 'no known error type or code' }
}

/** The last problem noted, or null. */
export const problemNoted = () => lastProblem

export const forgetProblem = (): void => {
  lastProblem = null
}

/** The versions the dbt doctor found, when it has run. */
export type DoctorFacts = { dbtCore?: string; adapter?: string; python?: string } | null

const VERSION = /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.+-]{1,40})?$/
/** A version as the doctor printed it, or null when it is anything else. */
export const asVersion = (text: unknown): string | null => (typeof text === 'string' && text.length <= 48 && VERSION.test(text) ? text : null)

/** The doctor's checks reduced to versions, never to their free text. */
export function doctorFacts(checks: ReadonlyArray<{ id: string; status: string; detail: string }>): DoctorFacts {
  const found: NonNullable<DoctorFacts> = {}
  for (const check of checks) {
    if (check.id === 'dbt') {
      const core = asVersion(/^dbt-core (\S+)/.exec(check.detail)?.[1])
      if (core) found.dbtCore = core
    } else if (check.id === 'python') {
      const python = asVersion(/^(?:Python )?(\d+\.\d+(?:\.\d+)?)/.exec(check.detail)?.[1])
      if (python) found.python = python
    } else if (check.id === 'adapter' && check.status === 'ok') {
      const match = /^([a-z][a-z0-9_]{1,30})(?: (\S+))?$/.exec(check.detail)
      const version = asVersion(match?.[2])
      if (match) found.adapter = version ? `${match[1]} ${version}` : match[1]
    }
  }
  return Object.keys(found).length ? found : null
}

