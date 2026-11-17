// For tests: what each data tool a feature asks for answers when there is nothing to report. A test's
// fake CLI answers these first, so the calls it records are its own and a feature that is built finds a
// project with nothing to say, whichever features are built.
const NOTHING_TO_REPORT: Record<string, Record<string, unknown>> = {
  docs_share_comments: { threads: [] },
  dbt_health: { success: true, insights: [] },
  dbt_defer_state: { success: true, enabled: false, mode: 'none' },
  dbt_cost_estimate: { supported: false, adapter: 'none' },
  dbt_run_results: { found: false },
  dbt_docs_coverage: { success: false },
}

/** The answer of the `altimate tool run <name>` in `argv` when `name` is one a feature asks for; null for any other command. */
export function nothingToReport(argv: readonly string[]): { exitCode: number; stdout: string; stderr: string } | null {
  const [, command, sub, name] = argv
  const metadata = command === 'tool' && sub === 'run' && name !== undefined ? NOTHING_TO_REPORT[name] : undefined
  if (!metadata) return null
  return { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata }), stderr: '' }
}
