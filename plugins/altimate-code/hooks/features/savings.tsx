// Savings: /savings checks a Databricks workspace's SQL warehouses for savings with Altimate's rules.
//
// The check is altimate-code's `finops_databricks_savings` tool: it measures each warehouse's usage
// from Databricks system tables with the person's own altimate-code connection, and altimate-core
// decides what qualifies and what it saves. This feature only asks for it and draws the answer
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
/** How many Databricks detectors Altimate's pipeline runs; the check runs two of them. */
export const SAAS_CHECK_COUNT = 15
const CHECK_COUNT = 2
// The queries read seven days of system tables and may start the connection's SQL warehouse.
const RUN_BUDGET_MS = 5 * 60_000
// Set for the tool's run only: altimate-code and altimate-core both read it. The run is kept out of
// altimate-code's tool daemon, which would keep the environment it started with.
const NO_TELEMETRY = { ALTIMATE_TELEMETRY_DISABLED: 'true' }

// An altimate-code connection name; anything else could read as a CLI flag.
const CONNECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const ADD_CONNECTION =
  'Add a Databricks connection to altimate-code (in ~/.altimate-code/connections.json: type "databricks", server_hostname, the http_path of a SQL warehouse and an access_token), then run /savings again.'

const reportAtom = atom({ plugin: 'altimate-code', key: 'savingsReport' } as const, null as SavingsView | null, { shape: 'savings-view-1' })
const busyAtom = atom({ plugin: 'altimate-code', key: 'savingsBusy' } as const, null as { label: string } | null)
const messageAtom = atom({ plugin: 'altimate-code', key: 'savingsMessage' } as const, null as { text: string; recovery: string } | null)
const bandAtom = atom({ plugin: 'altimate-code', key: 'savingsBand' } as const, null as { text: string } | null)

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
const size = (value: unknown) => String(value ?? '?').replace(/_/g, '-')
const count = (value: unknown) => Math.round(Number(value) || 0).toLocaleString('en-US')

/** What a finding rests on, one short line each, from the measured values core returned. */
export function evidenceLines(evidence: Record<string, unknown>): string[] {
  if (evidence.kind === 'serverless') {
    return [
      `${evidence.warehouse_type} ${size(evidence.warehouse_size)} warehouse, ${percent(evidence.idle_ratio)} idle over ${Number(evidence.wall_clock_uptime_hours).toFixed(1)} running hours (${count(evidence.total_query_count)} queries)`,
      `$${Number(evidence.current_dbu_cost).toFixed(2)} in DBUs over 7 days; serverless would bill $${Number(evidence.projected_serverless_dbu_cost).toFixed(2)} for the busy time alone`,
    ]
  }
  return [
    `${size(evidence.current_size)} warehouse used at most ${(Number(evidence.p99_utilization) * 100).toFixed(1)}% of its cores (p99 over ${count(evidence.parallelism_query_count)} queries)`,
    `${percent(evidence.no_spill_query_pct)} of queries never spilled to disk, ${percent(evidence.no_queue_query_pct)} never queued`,
    `${size(evidence.recommended_size)} is enough: ${count(evidence.current_dbu_per_hour)} → ${count(evidence.recommended_dbu_per_hour)} DBU an hour, on $${Number(evidence.total_cost).toFixed(2)} spent over 7 days`,
  ]
}

/** A size as the Databricks API spells it: `2X_SMALL` is `2X-Small`. */
export function apiSize(value: unknown): string {
  return String(value ?? '')
    .split(/[_-]/)
    .map(part => (/^\d*X$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join('-')
}

/** The change a finding points at, in plain words with the setting it means. */
function changeOf(evidence: Record<string, unknown>): string {
  return evidence.kind === 'serverless'
    ? 'switch it to a serverless SQL warehouse (enable_serverless_compute true, warehouse_type PRO)'
    : `resize it to ${apiSize(evidence.recommended_size)} (cluster_size "${apiSize(evidence.recommended_size)}")`
}

/** The request "Draft the fix" puts in the prompt box: everything Claude needs, and that nothing is to be applied. */
export function fixRequest(finding: { title: string; warehouse_id: string; warehouse_name: string; monthly_min: number; monthly_max: number; evidence: Record<string, unknown> }): string {
  return [
    `Draft the change for this Databricks savings finding, for me to review. Do not apply or run it.`,
    `Warehouse ${finding.warehouse_name} (id ${finding.warehouse_id}): ${finding.title}, ${range(finding.monthly_min, finding.monthly_max)} a month at list price.`,
    ...evidenceLines(finding.evidence).map(line => `- ${line}`),
    `The change: ${changeOf(finding.evidence)}.`,
    `If this repository defines the warehouse (a Databricks bundle, Terraform databricks_sql_endpoint, or JSON), edit that definition. Otherwise write the JSON for \`databricks warehouses edit ${finding.warehouse_id} --json\` and say what it changes.`,
  ].join('\n')
}

type ToolReport = {
  lookback_days: number
  findings: {
    title: string
    warehouse_id: string
    warehouse_name: string
    monthly_min: number
    monthly_max: number
    evidence: Record<string, unknown>
  }[]
  total: { monthly_min: number; monthly_max: number; warehouses: number }
}

type ToolMetadata = {
  success?: boolean
  error?: string
  window?: { start: string; end: string }
  warehouse?: string
  ran_on?: string
  warehouses_checked?: number
  report?: ToolReport
}

/** The tool's answer as the pane draws it, or null when it is not a report. */
export function toView(metadata: ToolMetadata | null): SavingsView | null {
  const report = metadata?.report
  if (!metadata?.success || !report || !Array.isArray(report.findings) || !metadata.window) return null
  return {
    connection: metadata.warehouse ?? null,
    ranOn: metadata.ran_on ?? null,
    window: metadata.window,
    warehousesChecked: metadata.warehouses_checked ?? 0,
    total: { min: report.total.monthly_min, max: report.total.monthly_max, warehouses: report.total.warehouses },
    findings: report.findings.map(one => ({
      title: one.title,
      warehouseId: one.warehouse_id,
      warehouseName: one.warehouse_name,
      monthlyMin: one.monthly_min,
      monthlyMax: one.monthly_max,
      evidence: evidenceLines(one.evidence),
      fixRequest: fixRequest(one),
    })),
  }
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

function summary(view: SavingsView): string {
  if (view.total.warehouses === 0) return `Databricks savings check: no savings found on ${view.warehousesChecked} SQL warehouses.`
  return `Databricks savings check: ${range(view.total.min, view.total.max)} a month on ${view.total.warehouses} SQL warehouse${view.total.warehouses === 1 ? '' : 's'}.`
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
    const view = toView(result.metadata as ToolMetadata | null)
    if (!view) {
      const error = (result.metadata as ToolMetadata | null)?.error ?? result.text
      await update($, messageAtom, () => explain(error || 'no answer'))
      return
    }
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
  const named = report?.findings.find(one => text.includes(one.warehouseName) || text.includes(one.warehouseId))
  if (named) return { text: `${named.warehouseName}: ${named.title}, ${range(named.monthlyMin, named.monthlyMax)} a month to save. /savings shows why.` }
  if (report || offered || !COMPUTE_WORDS.test(text)) return null
  offered = true
  return { text: 'Databricks compute in play: check its SQL warehouses for savings with /savings (read-only, on your own connection).' }
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
    await update($, busyAtom, () => ({ label: "Checking the workspace's SQL warehouses…" }))
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
    const again = () => later($, () => update($, busyAtom, () => ({ label: "Checking the workspace's SQL warehouses…" })).then(() => runCheck($, lastConnection)))
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
            {report.warehousesChecked} SQL warehouses · the 7 days to {report.window.end} 06:00 UTC{report.connection ? ` · connection ${report.connection}` : ''}
          </Text>
          <Text dimColor>Read-only, with your own connection. Nothing was sent to Altimate.</Text>
        </Box>
        {report.total.warehouses > 0 ? (
          <Box flexDirection="column">
            <Text bold color="success">
              {range(report.total.min, report.total.max)} a month
            </Text>
            <Text dimColor>
              on {report.total.warehouses} SQL warehouse{report.total.warehouses === 1 ? '' : 's'}, at list price and the last 7 days' rate, each warehouse counted once at its largest saving
            </Text>
          </Box>
        ) : (
          <Text>No savings found by these {CHECK_COUNT} checks.</Text>
        )}
        {report.findings.map((one, at) => (
          <Box key={`finding-${at}`} flexDirection="column">
            <Text bold>{`${one.warehouseName} · ${one.title} · ${range(one.monthlyMin, one.monthlyMax)} a month`}</Text>
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
    description: "Check a Databricks workspace's SQL warehouses for savings with Altimate's rules: read-only, on your own connection",
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
            await update($, busyAtom, () => ({ label: "Checking the workspace's SQL warehouses…" }))
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
