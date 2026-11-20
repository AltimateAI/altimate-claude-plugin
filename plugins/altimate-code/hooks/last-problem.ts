// What /feedback may attach, kept apart from feedback.ts so the dbt helpers can record into it without importing it: the
// last plugin error (in memory only) and the versions the dbt doctor found.
/** The raw problem text kept in memory, before it is redacted and cut. */
export const MAX_RAW_PROBLEM = 8000

let lastProblem: { source: string; raw: string; names: string[] } | null = null

/** Remembers the last plugin error, in memory only, for `--with-error`. `source` is the plugin's own words ("dbt run failed"), `raw` the error, `names` the nodes it is about. */
export function noteProblem(source: string, raw: string, names: readonly string[] = []): void {
  lastProblem = { source: source.slice(0, 80), raw: String(raw).slice(0, MAX_RAW_PROBLEM), names: names.slice(0, 20) }
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

