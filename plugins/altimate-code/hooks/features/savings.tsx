// Savings: /savings checks a Databricks workspace's SQL warehouses, all-purpose clusters and jobs for
// savings with Altimate's rules.
//
// The check is altimate-code's `finops_databricks_savings` tool: it measures each resource's usage
// from Databricks system tables with the person's own altimate-code connection, and altimate-core
// decides what qualifies, what it saves, and what each flagged warehouse would cost instead. This feature only asks for it and draws the answer
// beside the chat, with telemetry off for that run, so nothing about the run reaches Altimate.
import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, EventResult, On, RenderElement, ToolCallResult } from 'claude-code'

import type { SavingsView } from '../../types'
import { MISSING_BINARY, later, runTool } from '../altimate-cli'
import type { BashCall, ContextLines, EditedFile, FileCall } from '../tool-chain'
import type { BandUi, FeatureContext } from './index'

const COMMAND = 'savings'
const PANE = 'altimate-savings'
const PANE_TITLE = 'Databricks savings'
const PANE_SIZE = { columns: 96, rows: 34 }
const TOOL = 'finops_databricks_savings'
export const SIGNUP_URL = 'https://app.myaltimate.com/register'
/** How many Databricks detectors Altimate's pipeline runs; the check runs four of them. */
export const SAAS_CHECK_COUNT = 15
const CHECK_COUNT = 4
// The queries read seven days of system tables and may start the connection's SQL warehouse.
const RUN_BUDGET_MS = 5 * 60_000
// Set for the tool's run only: altimate-code and altimate-core both read it. The run is kept out of
// altimate-code's tool daemon, which would keep the environment it started with.
const NO_TELEMETRY = { ALTIMATE_TELEMETRY_DISABLED: 'true' }

// An altimate-code connection name; anything else could read as a CLI flag.
const CONNECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const ADD_CONNECTION =
  'Add a Databricks connection to altimate-code (in ~/.altimate-code/connections.json: type "databricks", server_hostname, the http_path of a SQL warehouse and an access_token), then run /savings again.'

const reportAtom = atom({ plugin: 'altimate-code', key: 'savingsReport' } as const, null as SavingsView | null, { shape: 'savings-view-2' })
const busyAtom = atom({ plugin: 'altimate-code', key: 'savingsBusy' } as const, null as { label: string } | null)
const messageAtom = atom({ plugin: 'altimate-code', key: 'savingsMessage' } as const, null as { text: string; recovery: string } | null)
const bandAtom = atom({ plugin: 'altimate-code', key: 'savingsBand' } as const, null as { text: string } | null)
// The alternative pressed in the pane's what-if row: which warehouse, and which choice.
const whatIfAtom = atom({ plugin: 'altimate-code', key: 'savingsWhatIf' } as const, null as { resourceId: string; label: string } | null)

// Each run takes a number; /clear, a resume or a reload moves it on, so a run still waiting on
// Databricks when the conversation changed never writes its report into the new one.
let generation = 0
let lastConnection: string | null = null
// The once-a-session offer of /savings when the session first touches Databricks config.
let offered = false

// Files that define Databricks compute: bundles, their resources, Terraform. Read only when one is edited.
const DATABRICKS_CONFIG = /(^|\/)(databricks\.ya?ml|resources\/[^/]+\.ya?ml|[^/]+\.tf)$/i
// What marks such a file, or a command, as about warehouses or clusters.
const COMPUTE_WORDS = /sql_endpoint|sql_warehouse|warehouse|cluster/i
const DATABRICKS_COMMAND = /^\s*databricks\s+(warehouses|clusters|bundle|jobs)\b/
const BAND_READ_LIMIT = 200_000

export function dollars(value: number): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  const [whole, cents] = rounded.toFixed(value >= 100 ? 0 : 2).split('.')
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents ? `.${cents}` : ''}`
}

function range(min: number, max: number): string {
  return dollars(min) === dollars(max) ? dollars(max) : `${dollars(min)}–${dollars(max)}`
}

const percent = (share: unknown) => `${Math.round(Number(share) * 100)}%`
const percentOf = (value: unknown) => `${Math.round(Number(value))}%`
const size = (value: unknown) => String(value ?? '?').replace(/_/g, '-')
const count = (value: unknown) => Math.round(Number(value) || 0).toLocaleString('en-US')
const MONTH_PER_WINDOW = 30 / 7

/** What a finding rests on, one short line each, from the measured values core returned. */
export function evidenceLines(evidence: Record<string, unknown>): string[] {
  switch (evidence.kind) {
    case 'serverless':
      return [
        `${evidence.warehouse_type} ${size(evidence.warehouse_size)} warehouse, ${percent(evidence.idle_ratio)} idle over ${Number(evidence.wall_clock_uptime_hours).toFixed(1)} running hours (${count(evidence.total_query_count)} queries)`,
        `$${Number(evidence.current_dbu_cost).toFixed(2)} in DBUs over 7 days; serverless would bill $${Number(evidence.projected_serverless_dbu_cost).toFixed(2)} for the busy time alone`,
      ]
    case 'over_sized':
      return [
        `${size(evidence.current_size)} warehouse used at most ${(Number(evidence.p99_utilization) * 100).toFixed(1)}% of its cores (p99 over ${count(evidence.parallelism_query_count)} queries)`,
        `${percent(evidence.no_spill_query_pct)} of queries never spilled to disk, ${percent(evidence.no_queue_query_pct)} never queued`,
        `${size(evidence.recommended_size)} is enough: ${count(evidence.current_dbu_per_hour)} → ${count(evidence.recommended_dbu_per_hour)} DBU an hour, on $${Number(evidence.total_cost).toFixed(2)} spent over 7 days`,
      ]
    case 'idle_cluster':
      return [
        `All-purpose cluster ${percent(evidence.idle_ratio)} idle across ${count(evidence.active_days)} active days (${String(evidence.idle_pattern).replace(/_/g, ' ')}), average worker CPU ${percentOf(evidence.avg_cpu_active_pct)}, peak ${percentOf(evidence.peak_cpu_active_pct)}`,
        `Auto-termination ${evidence.auto_termination_minutes ? `${evidence.auto_termination_minutes} minutes` : 'off'}; $${Number(evidence.total_cost).toFixed(2)} billed outside job runs over 7 days`,
      ]
    case 'job_on_all_purpose':
      return [
        `${count(evidence.run_count)} runs (${String(evidence.trigger_type ?? 'manual').toLowerCase()}), ${percent(evidence.all_purpose_share)} of its cost on all-purpose compute, ${percent(evidence.job_share_of_cluster)} of its cluster's`,
        `$${Number(evidence.all_purpose_rate_per_dbu).toFixed(3)} a DBU now; a job cluster would be about $${Number(evidence.jobs_rate_per_dbu).toFixed(3)}${evidence.jobs_rate_estimated ? ' (estimated: the workspace billed no jobs compute)' : ''}`,
      ]
    default:
      return []
  }
}

/** A size as the Databricks API spells it: `2X_SMALL` is `2X-Small`. */
export function apiSize(value: unknown): string {
  return String(value ?? '')
    .split(/[_-]/)
    .map(part => (/^\d*X$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join('-')
}

type ToolFinding = {
  title: string
  resource_type: string
  resource_id: string
  resource_name: string
  monthly_min: number
  monthly_max: number
  evidence: Record<string, unknown>
}

/** The change a finding points at, the noun for its resource, and where the change is written. */
function changeOf(finding: ToolFinding): { noun: string; change: string; where: string } {
  const e = finding.evidence
  const id = finding.resource_id
  switch (e.kind) {
    case 'serverless':
      return {
        noun: 'Warehouse',
        change: 'switch it to a serverless SQL warehouse (enable_serverless_compute true, warehouse_type PRO)',
        where: `a Databricks bundle, Terraform databricks_sql_endpoint, or JSON; otherwise write the JSON for \`databricks warehouses edit ${id} --json\``,
      }
    case 'over_sized':
      return {
        noun: 'Warehouse',
        change: `resize it to ${apiSize(e.recommended_size)} (cluster_size "${apiSize(e.recommended_size)}")`,
        where: `a Databricks bundle, Terraform databricks_sql_endpoint, or JSON; otherwise write the JSON for \`databricks warehouses edit ${id} --json\``,
      }
    case 'idle_cluster':
      return {
        noun: 'Cluster',
        change:
          e.idle_pattern === 'zombie'
            ? 'it is idle almost all the time: set autotermination_minutes to 15, or terminate it if nobody needs it'
            : 'set autotermination_minutes to 30 so idle workers stop billing',
        where: `Terraform databricks_cluster, a cluster policy or JSON; otherwise write the JSON for \`databricks clusters edit ${id} --json\``,
      }
    case 'job_on_all_purpose':
      return {
        noun: 'Job',
        change: "run it on a job cluster: give its tasks a new_cluster (or job_cluster_key) instead of existing_cluster_id, sized like the cluster it uses now",
        where: `the job's bundle resource, Terraform databricks_job or JSON; otherwise write the settings for \`databricks jobs reset ${id} --json\``,
      }
    default:
      return { noun: 'Resource', change: 'make the change the evidence points at', where: 'its definition' }
  }
}

/** The request "Draft the fix" puts in the prompt box: everything Claude needs, and that nothing is to be applied. */
export function fixRequest(finding: ToolFinding): string {
  const { noun, change, where } = changeOf(finding)
  return [
    'Draft the change for this Databricks savings finding, for me to review. Do not apply or run it.',
    `${noun} ${finding.resource_name} (id ${finding.resource_id}): ${finding.title}, ${range(finding.monthly_min, finding.monthly_max)} a month at list price.`,
    ...evidenceLines(finding.evidence).map(line => `- ${line}`),
    `The change: ${change}.`,
    `If this repository defines it (${where}), and say what it changes.`,
  ].join('\n')
}

type ToolWhatIf = {
  resource_id: string
  resource_name: string
  current_label: string
  current_monthly_cost: number
  choices: { label: string; monthly_cost: number; monthly_saving: number; fits: boolean; cores: number; cores_needed: number }[]
}

type ToolWarehouse = { id: string; name: string; type: string; size: string | null; window_cost: number }

type ToolMetadata = {
  success?: boolean
  error?: string
  window?: { start: string; end: string }
  warehouse?: string
  ran_on?: string
  warehouses_checked?: number
  clusters_checked?: number
  jobs_checked?: number
  skipped?: { check: string; reason: string }[]
  warehouses?: ToolWarehouse[]
  report?: {
    lookback_days: number
    findings: ToolFinding[]
    total: { monthly_min: number; monthly_max: number; resources: number }
    what_if?: ToolWhatIf[]
  }
}

const RESOURCE_NOUN: Record<string, string> = { sql_warehouse: 'SQL warehouse', cluster: 'cluster', job: 'job' }

/** The tool's answer as the pane draws it, or null when it is not a report. */
export function toView(metadata: ToolMetadata | null): SavingsView | null {
  const report = metadata?.report
  if (!metadata?.success || !report || !Array.isArray(report.findings) || !metadata.window) return null
  return {
    connection: metadata.warehouse ?? null,
    ranOn: metadata.ran_on ?? null,
    window: metadata.window,
    checked: { warehouses: metadata.warehouses_checked ?? 0, clusters: metadata.clusters_checked ?? 0, jobs: metadata.jobs_checked ?? 0 },
    skipped: (metadata.skipped ?? []).map(one => one.check),
    total: { min: report.total.monthly_min, max: report.total.monthly_max, resources: report.total.resources },
    findings: report.findings.map(one => ({
      title: one.title,
      resourceType: one.resource_type,
      resourceId: one.resource_id,
      resourceName: one.resource_name,
      monthlyMin: one.monthly_min,
      monthlyMax: one.monthly_max,
      evidence: evidenceLines(one.evidence),
      fixRequest: fixRequest(one),
    })),
    whatIf: (report.what_if ?? []).map(one => ({
      resourceId: one.resource_id,
      resourceName: one.resource_name,
      currentLabel: one.current_label,
      currentMonthly: one.current_monthly_cost,
      choices: one.choices.map(choice => ({
        label: size(choice.label),
        monthlyCost: choice.monthly_cost,
        monthlySaving: choice.monthly_saving,
        fits: choice.fits,
        cores: choice.cores,
        coresNeeded: choice.cores_needed,
      })),
    })),
    changes: [],
  }
}

/** What a warehouse was when a run first flagged it, kept across sessions to tell what a change saved. */
type Baseline = { date: string; type: string; size: string | null; windowCost: number }

const baselineKey = (connection: string, warehouseId: string) => `savings-baseline:${connection}:${warehouseId}`

/**
 * Each flagged warehouse's state is kept the first time a run flags it. A later run that finds its
 * size or type changed reports what it cost a month then and now, from the two windows' measured cost.
 */
export async function trackChanges($: EngineInterface, view: SavingsView, warehouses: ToolWarehouse[], today: string): Promise<SavingsView['changes']> {
  const connection = view.connection ?? 'default'
  const flagged = new Set(view.findings.filter(one => one.resourceType === 'sql_warehouse').map(one => one.resourceId))
  const changes: SavingsView['changes'] = []
  for (const warehouse of warehouses) {
    const key = baselineKey(connection, warehouse.id)
    const stored = (await $.store.get(key).catch(() => undefined)) as Baseline | undefined
    const changed = stored && (stored.size !== warehouse.size || stored.type !== warehouse.type)
    if (stored && changed) {
      changes.push({
        name: warehouse.name,
        from: `${size(stored.size)} ${stored.type}`,
        to: `${size(warehouse.size)} ${warehouse.type}`,
        since: stored.date,
        monthlyBefore: stored.windowCost * MONTH_PER_WINDOW,
        monthlyNow: warehouse.window_cost * MONTH_PER_WINDOW,
      })
    }
    if (!stored && flagged.has(warehouse.id)) {
      await $.store
        .set(key, { date: today, type: warehouse.type, size: warehouse.size, windowCost: warehouse.window_cost } satisfies Baseline)
        .catch(() => undefined)
    }
  }
  return changes
}

/** The refusal in the person's terms, with the step that fixes it. */
export function explain(error: string): { text: string; recovery: string } {
  if (/^Unknown tool: finops_databricks_savings/.test(error) || /has no Databricks savings rules/.test(error)) {
    return { text: 'This altimate-code has no Databricks savings check.', recovery: 'Update altimate-code (`altimate upgrade`), then run /savings again.' }
  }
  if (/requires a configured warehouse|not supported by any of your configured warehouses/.test(error)) {
    return { text: 'altimate-code has no Databricks connection.', recovery: ADD_CONNECTION }
  }
  if (/is not configured\. Available warehouses/.test(error)) {
    return { text: error.replace(/ Pass one of those.*$/, ''), recovery: 'Run /savings <connection> with one of those names, or /savings to use the first Databricks connection.' }
  }
  if (/is not available for \S+ warehouses/.test(error)) {
    return { text: 'That connection is not a Databricks one.', recovery: 'Run /savings <connection> with a Databricks connection, or /savings to use the first one.' }
  }
  if (/^No SQL warehouses were found for warehouse/.test(error)) {
    return {
      text: "The connection's SQL warehouse is not in system.compute.warehouses yet.",
      recovery: 'A new warehouse appears there within a few hours; try again later, or connect through an older SQL warehouse.',
    }
  }
  if (/does not go through a SQL warehouse/.test(error)) {
    return { text: 'The Databricks connection does not go through a SQL warehouse.', recovery: 'Set its http_path to a SQL warehouse (/sql/1.0/warehouses/<id>), then run /savings again.' }
  }
  if (/TABLE_OR_VIEW_NOT_FOUND|PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS/.test(error)) {
    return {
      text: `A query was refused: ${error.split('\n')[0]!.slice(0, 200)}`,
      recovery: 'The check reads system.billing, system.compute and system.query: ask a workspace admin for SELECT on those schemas, then run /savings again.',
    }
  }
  return { text: `The savings check failed: ${error.split('\n')[0]!.slice(0, 300)}`, recovery: 'Run /savings again; if it fails again, run the same check in a terminal: `altimate tool run finops_databricks_savings --args \'{}\'`.' }
}

function checkedText(view: SavingsView): string {
  return `${view.checked.warehouses} SQL warehouses, ${view.checked.clusters} all-purpose clusters and ${view.checked.jobs} jobs`
}

function summary(view: SavingsView): string {
  if (view.total.resources === 0) return `Databricks savings check: no savings found on ${checkedText(view)}.`
  return `Databricks savings check: ${range(view.total.min, view.total.max)} a month on ${view.total.resources} resource${view.total.resources === 1 ? '' : 's'}.`
}

async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: PANE_TITLE, ...PANE_SIZE, focus: true, closeOnEscape: true }).catch(() => null)
}

async function runCheck($: EngineInterface, connection: string | null) {
  const mine = ++generation
  const live = () => mine === generation
  lastConnection = connection
  offered = true
  try {
    await update($, messageAtom, () => null)
    await update($, bandAtom, () => null)
    const until = (await $.clock.now()) + RUN_BUDGET_MS
    const result = await runTool($, TOOL, connection ? { warehouse: connection } : {}, { cliOnly: true, until, env: NO_TELEMETRY, noDaemon: true })
    if (!live()) return
    const metadata = result.metadata as ToolMetadata | null
    const view = toView(metadata)
    if (!view) {
      const error = (result.metadata as ToolMetadata | null)?.error ?? result.text
      await update($, messageAtom, () => explain(error || 'no answer'))
      return
    }
    const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
    view.changes = await trackChanges($, view, metadata?.warehouses ?? [], today)
    if (!live()) return
    await update($, whatIfAtom, () => null)
    await update($, reportAtom, () => view)
    $.ui.toast(summary(view))
  } catch (error) {
    if (!live()) return
    const missing = MISSING_BINARY.test(String(error))
    await update($, messageAtom, () =>
      missing
        ? { text: 'altimate-code is not installed.', recovery: 'Install it (`npm install -g altimate-code`), add a Databricks connection, then run /savings again.' }
        : explain(String(error)),
    )
  } finally {
    if (live()) await update($, busyAtom, () => null)
  }
}

/** Puts the finding's fix request in the prompt box; nothing is sent until the person presses Enter. */
async function draftFix($: EngineInterface, request: string) {
  const filled = await $.prompt.fill({ text: request }).catch(() => null)
  $.ui.toast(
    filled?.isFilled
      ? 'The fix request is in your prompt box: edit it, or press Enter to have Claude draft the change.'
      : 'There is no prompt box to fill here; copy the request from the pane instead.',
  )
}

/** The band's line for a Databricks config file or command: a finding it names, else the once-a-session offer. */
async function bandFor($: EngineInterface, text: string): Promise<{ text: string } | null> {
  const report = await read($, reportAtom)
  const named = report?.findings.find(one => text.includes(one.resourceName) || text.includes(one.resourceId))
  if (named) return { text: `${named.resourceName}: ${named.title}, ${range(named.monthlyMin, named.monthlyMax)} a month to save. /savings shows why.` }
  if (report || offered || !COMPUTE_WORDS.test(text)) return null
  offered = true
  return { text: 'Databricks compute in play: check its warehouses, clusters and jobs for savings with /savings (read-only, on your own connection).' }
}

/** Adds this feature's own hooks. */
export function register(on: On, _context: FeatureContext) {
  on('command.run', { command: COMMAND }, async ($, e) => {
    const asked = e.args.trim()
    if (asked && !CONNECTION_NAME.test(asked)) {
      return { text: `"${asked}" is not a connection name. Run /savings, or /savings <connection> with an altimate-code Databricks connection.` }
    }
    if (await read($, busyAtom)) {
      await openPane($)
      return { text: 'The Databricks savings check is already running in the side pane.' }
    }
    await update($, busyAtom, () => ({ label: "Checking the workspace's warehouses, clusters and jobs…" }))
    const opened = await openPane($)
    later($, () => runCheck($, asked || null))
    if (opened && opened.isPlaced === false) {
      return { text: 'Running the Databricks savings check. The terminal is too narrow for the side pane, so the result comes as a notice; widen the window to see the details.' }
    }
    return { text: 'Running the Databricks savings check in the side pane: read-only queries on your own Databricks connection. Nothing is sent to Altimate.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const report = await read($, reportAtom)
    const running = await read($, busyAtom)
    const message = await read($, messageAtom)
    const picked = await read($, whatIfAtom)
    const again = () => later($, () => update($, busyAtom, () => ({ label: "Checking the workspace's warehouses, clusters and jobs…" })).then(() => runCheck($, lastConnection)))
    const close = () => later($, () => $.ui.close({ id: PANE }))
    const buttons = (
      <Box gap={1} key="buttons">
        <Button key="again" label="Run again" onPress={again} />
        <Button key="close" label="Close" onPress={close} />
      </Box>
    )

    if (running) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Databricks savings check</Text>
          <Text dimColor>{running.label}</Text>
          <Text dimColor>Read-only queries on Databricks system tables, with your own connection. Nothing is sent to Altimate.</Text>
        </Box>
      )
    }

    if (!report || message) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Databricks savings check</Text>
          {message ? (
            <Box flexDirection="column">
              <Text color="warning">{message.text}</Text>
              <Text>{message.recovery}</Text>
            </Box>
          ) : (
            <Text dimColor>Run /savings, or /savings &lt;connection&gt;, to check a Databricks workspace.</Text>
          )}
          {buttons}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Databricks savings check</Text>
          <Text dimColor>
            {checkedText(report)} · the 7 days to {report.window.end}
            {report.connection ? ` · connection ${report.connection}` : ''}
          </Text>
          <Text dimColor>Read-only, with your own connection. Nothing was sent to Altimate.</Text>
        </Box>
        {report.changes.map((one, at) => (
          <Text key={`change-${at}`} color="success">
            {`${one.name}: ${one.from} → ${one.to} since ${one.since}. ${dollars(one.monthlyBefore)} a month then, ${dollars(one.monthlyNow)} now${one.monthlyBefore > one.monthlyNow ? `: ${dollars(one.monthlyBefore - one.monthlyNow)} a month saved` : ''}.`}
          </Text>
        ))}
        {report.total.resources > 0 ? (
          <Box flexDirection="column">
            <Text bold color="success">
              {range(report.total.min, report.total.max)} a month
            </Text>
            <Text dimColor>
              on {report.total.resources} resource{report.total.resources === 1 ? '' : 's'}, at list price and the last 7 days' rate, each counted once at its largest saving
            </Text>
          </Box>
        ) : (
          <Text>No savings found by these {CHECK_COUNT} checks.</Text>
        )}
        {report.findings.map((one, at) => (
          <Box key={`finding-${at}`} flexDirection="column">
            <Text bold>{`${one.resourceName} · ${one.title} · ${range(one.monthlyMin, one.monthlyMax)} a month`}</Text>
            <Box flexDirection="column" paddingLeft={2}>
              {one.evidence.map((line, row) => (
                <Text key={`finding-${at}-${row}`} dimColor>
                  {line}
                </Text>
              ))}
              <Box>
                <Button key={`fix-${at}`} label="Draft the fix" onPress={() => later($, () => draftFix($, one.fixRequest))} />
              </Box>
            </Box>
          </Box>
        ))}
        {report.whatIf.map((one, at) => {
          const choice = picked?.resourceId === one.resourceId ? one.choices.find(c => c.label === picked.label) : undefined
          return (
            <Box key={`whatif-${at}`} flexDirection="column">
              <Text bold>{`What if ${one.resourceName} (${dollars(one.currentMonthly)} a month now) were…`}</Text>
              <Box gap={1} flexWrap="wrap">
                {one.choices.map((c, k) => (
                  <Button
                    key={`whatif-${at}-${k}`}
                    label={`${c.label} ${dollars(c.monthlyCost)}${c.fits ? '' : ' ⚠'}`}
                    onPress={() => later($, () => update($, whatIfAtom, () => ({ resourceId: one.resourceId, label: c.label })))}
                  />
                ))}
              </Box>
              {choice ? (
                <Text color={choice.fits ? 'success' : 'warning'}>
                  {choice.label === 'SERVERLESS'
                    ? `As serverless: ${dollars(choice.monthlyCost)} a month instead of ${dollars(one.currentMonthly)}, ${dollars(choice.monthlySaving)} less: it bills only while queries run.`
                    : choice.fits
                      ? `At ${choice.label}: ${dollars(choice.monthlyCost)} a month instead of ${dollars(one.currentMonthly)}, ${dollars(choice.monthlySaving)} less. Its ${choice.cores} cores cover the ${choice.coresNeeded.toFixed(0)} its queries need (twice what 99% of them use).`
                      : `At ${choice.label}: ${dollars(choice.monthlyCost)} a month, but its ${choice.cores} cores are short of the ${choice.coresNeeded.toFixed(0)} its queries need (twice what 99% of them use): queries would queue.`}
                </Text>
              ) : (
                <Text dimColor>Press a size to see what it would cost and whether it fits.</Text>
              )}
            </Box>
          )
        })}
        {report.skipped.length > 0 ? (
          <Text dimColor>{`Not checked (the connection cannot read their system tables): ${report.skipped.join(', ')}.`}</Text>
        ) : null}
        <Box flexDirection="column" key="pitch">
          <Text dimColor>
            These were {CHECK_COUNT} of Altimate's {SAAS_CHECK_COUNT} Databricks checks, on one workspace. Altimate runs all {SAAS_CHECK_COUNT} every day on every workspace
            you connect, tracks what each change saves, and its Auto Tune can change a SQL warehouse's size and auto-stop for you.
          </Text>
          <Link href={SIGNUP_URL} label="See all of it in Altimate: app.myaltimate.com/register" />
        </Box>
        {buttons}
      </Box>
    )
  })
}

/** After the session started: the place to register commands. */
export async function sessionStart($: EngineInterface, _e: Args<'session.start'>) {
  // A run that was going when the last session ended can never finish, so it must not block this one.
  await update($, busyAtom, () => null)
  await $.command.register({
    name: COMMAND,
    description: "Check a Databricks workspace's warehouses, clusters and jobs for savings with Altimate's rules: read-only, on your own connection",
    argumentHint: '[altimate-code connection]',
  })
}

export async function turnStart($: EngineInterface, e: Args<'turn.start'>) {}

export async function turnComplete($: EngineInterface, e: Args<'turn.complete'>, out: EventResult<'turn.complete'>) {}

/** A /clear, a resume or a logout: forget the report and any run still waiting. */
export async function sessionEnd($: EngineInterface, _e: Args<'session.end'>) {
  generation += 1
  lastConnection = null
  offered = false
  await update($, bandAtom, () => null)
  await update($, whatIfAtom, () => null)
  await update($, reportAtom, () => null)
  await update($, busyAtom, () => null)
  await update($, messageAtom, () => null)
}

export async function bandLine($: EngineInterface, ui: BandUi): Promise<RenderElement | null> {
  const band = await read($, bandAtom)
  if (!band) return null
  const { Box, Button, Text } = ui
  return (
    <Box gap={1}>
      <Text>{band.text}</Text>
      <Button
        key="savings-run"
        label="Run /savings"
        onPress={() =>
          later($, async () => {
            await update($, busyAtom, () => ({ label: "Checking the workspace's warehouses, clusters and jobs…" }))
            await openPane($)
            await runCheck($, lastConnection)
          })
        }
      />
      <Button key="savings-hide" label="Hide" onPress={() => later($, () => update($, bandAtom, () => null))} />
    </Box>
  )
}

export async function bashRewrite($: EngineInterface, e: BashCall): Promise<string | null> {
  return null
}

export async function bashGate($: EngineInterface, e: BashCall): Promise<{ deny: string } | null> {
  return null
}

export async function bashAfter($: EngineInterface, e: BashCall, result: ToolCallResult): Promise<ContextLines> {
  if (!DATABRICKS_COMMAND.test(e.command)) return
  const band = await bandFor($, e.command)
  if (band) await update($, bandAtom, () => band)
}

export async function editAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: EditedFile): Promise<ContextLines> {
  if (!DATABRICKS_CONFIG.test(file.path.replace(/\\/g, '/'))) return
  const text = String((await $.fs.read(file.path).catch(() => '')) ?? '').slice(0, BAND_READ_LIMIT)
  const band = await bandFor($, text)
  if (band) await update($, bandAtom, () => band)
}

export async function readOrEditAfter($: EngineInterface, e: FileCall, result: ToolCallResult, file: { path: string }): Promise<ContextLines> {}

export const editReadsBefore = false
