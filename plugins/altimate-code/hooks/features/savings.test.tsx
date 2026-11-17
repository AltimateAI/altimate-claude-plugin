import { expect, mock, test } from 'claude-code/testing'

import { SIGNUP_URL, apiSize, dollars, explain } from './savings'

const ROOT = '/repo'

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-savings',
  props: { title: 'Databricks savings', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

// `altimate tool run finops_databricks_savings --args '{}' --json` on a live workspace for the seven
// days to 2026-11-17 06:00 UTC (warehouse ids replaced).
const ANSWER = {
  status: 'ok',
  title: 'Databricks Savings: $85.17–$106 a month on 1 warehouse(s)',
  output: 'Databricks SQL warehouse savings, 5 warehouses checked, …',
  metadata: {
    success: true,
    window: { start: '2026-11-10', end: '2026-11-17' },
    warehouse: 'dbxmega',
    ran_on: 'wh-xs',
    warehouses_checked: 5,
    truncated: false,
    report: {
      lookback_days: 7,
      findings: [
        {
          check_id: 'wh_classic_pro_to_serverless',
          title: 'Migrate Classic/Pro to Serverless',
          warehouse_id: 'wh-classic',
          warehouse_name: 'Classic',
          severity: 'critical',
          daily_min: 2.8389970568078615,
          daily_max: 3.5487463210098267,
          monthly_min: 85.16991170423584,
          monthly_max: 106.4623896302948,
          evidence: {
            kind: 'serverless',
            warehouse_type: 'CLASSIC',
            warehouse_size: 'SMALL',
            idle_ratio: 0.9523043043299816,
            wall_clock_uptime_hours: 10.828888888888889,
            total_query_count: 2988,
            price_per_dbu: 0.22,
            serverless_price_per_dbu: 0.7,
            current_dbu_cost: 29.28557470666667,
            projected_serverless_dbu_cost: 4.44435045959788,
            wasted_cost: 24.841224247068787,
          },
        },
        {
          check_id: 'wh_oversized',
          title: 'Over-Sized Warehouse',
          warehouse_id: 'wh-classic',
          warehouse_name: 'Classic',
          severity: 'medium',
          daily_min: 1.1156410285714287,
          daily_max: 1.9523717999999999,
          monthly_min: 33.46923085714286,
          monthly_max: 58.57115399999999,
          evidence: {
            kind: 'over_sized',
            current_size: 'SMALL',
            recommended_size: '2X_SMALL',
            available_cores: 32,
            p99_utilization: 0.10725396430349142,
            parallelism_query_count: 2669,
            no_spill_query_pct: 1,
            no_queue_query_pct: 1,
            current_dbu_per_hour: 12,
            recommended_dbu_per_hour: 4,
            total_cost: 29.285577,
            wasted_cost: 19.523718,
          },
        },
      ],
      total: { monthly_min: 85.16991170423584, monthly_max: 106.4623896302948, warehouses: 1 },
    },
  },
}

/** The tool's failure as `tool run --json` prints it: `status: ok`, the reason in the metadata. */
function failure(error: string) {
  return { status: 'ok', title: 'Databricks Savings: FAILED', output: `The Databricks savings check failed: ${error}`, metadata: { success: false, error } }
}

type Options = {
  answer?: unknown
  /** `tool run` exits 1 with this answer, as altimate-code does for a tool it does not have. */
  error?: unknown
  missingCli?: boolean
  hold?: Promise<void>
  isPlaced?: boolean
  now?: number
  /** File texts `$.fs.read` answers, by path. */
  files?: Record<string, string>
  /** Whether the prompt box takes a fill. */
  canFill?: boolean
}

async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on, { now: options.now ?? Date.parse('2026-11-17T10:00:00Z') })
  const runs: { argv: string[]; env: Record<string, string> | undefined }[] = []
  const toasts: string[] = []
  const fills: string[] = []
  on('prompt.fill', (_: unknown, e: { text: string }) => {
    if (options.canFill === false) return { isFilled: false, reason: 'no_composer' }
    fills.push(e.text)
    return { isFilled: true }
  })
  on('command.register', () => ({ value: { command: 'savings' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.open', () => ({ value: options.isPlaced === false ? { isPlaced: false } : {} }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: options.files?.[e.path] ?? '' }))
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: { env?: Record<string, string> } }) => {
    const [, command, , tool] = e.argv
    // The other halves of the plugin ask the CLI for other things at session start.
    if (command !== 'tool' || tool !== 'finops_databricks_savings') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    runs.push({ argv: [...e.argv], env: e.init?.env })
    if (options.missingCli) return { deny: 'spawn altimate ENOENT' }
    if (options.hold) await options.hold
    if (options.error) return { value: { exitCode: 1, stdout: JSON.stringify(options.error), stderr: '' } }
    return { value: { exitCode: 0, stdout: JSON.stringify(options.answer ?? ANSWER), stderr: '' } }
  })
  on('tool.call', () => ({ result: { ok: true } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, runs, toasts, fills }
}

const composer = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 200 } }

async function savings($: any, args = '') {
  return $.command.run({ command: 'savings', args, ...composer })
}

test('/savings runs the altimate-code tool once with telemetry off and draws its findings, on every surface', async ($, on) => {
  const { clock, runs, toasts } = await start($, on)
  const said = await savings($)
  await clock.settle()

  expect(runs.length).toBe(1)
  // The run stays out of altimate-code's tool daemon, which keeps the environment it started with.
  expect(runs[0]!.argv.slice(1)).toEqual(['tool', 'run', 'finops_databricks_savings', '--args', '{}', '--json', '--no-daemon'])
  expect(runs[0]!.env).toEqual({ ALTIMATE_TELEMETRY_DISABLED: 'true' })
  // The reply in the conversation names no figure, warehouse or workspace: the findings stay in the pane.
  expect(said.text).toContain('Nothing is sent to Altimate')
  expect(said.text).not.toMatch(/\$|Classic|dbxmega/)
  expect(toasts.at(-1)).toBe('Databricks savings check: $85.17–$106 a month on 1 SQL warehouse.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^\$85\.17–\$106 a month$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Classic · Migrate Classic\/Pro to Serverless · \$85\.17–\$106 a month$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Classic · Over-Sized Warehouse · \$33\.47–\$58\.57 a month$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^CLASSIC SMALL warehouse, 95% idle over 10\.8 running hours \(2,988 queries\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2X-SMALL is enough: 12 → 4 DBU an hour, on \$29\.29 spent over 7 days$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5 SQL warehouses · the 7 days to 2026-11-17 06:00 UTC · connection dbxmega/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /These were 2 of Altimate's 15 Databricks checks/ })).toBeDefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(SIGNUP_URL)
    await ui.unmount()
  }
})

test('/savings <connection> asks for that connection', async ($, on) => {
  const { clock, runs } = await start($, on)
  await savings($, 'prod_dbx')
  await clock.settle()
  expect(JSON.parse(runs[0]!.argv[5]!)).toEqual({ warehouse: 'prod_dbx' })
})

test('an argument that is not a connection name never reaches the CLI', async ($, on) => {
  const { clock, runs } = await start($, on)
  for (const args of ['--host=https://evil.example', 'a b', '$(whoami)', '-p']) {
    expect((await savings($, args)).text).toContain('is not a connection name')
  }
  await clock.settle()
  expect(runs).toEqual([])
})

test('an altimate-code without the tool says to update it', async ($, on) => {
  // What altimate-code prints for a tool it does not have.
  const error = { status: 'error', title: 'Unknown tool', output: 'Unknown tool: finops_databricks_savings. Run `altimate-code tool list` to see the available tools.', metadata: {} }
  const { clock } = await start($, on, { error })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^This altimate-code has no Databricks savings check\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /altimate upgrade/ })).toBeDefined()
  await ui.unmount()
})

test('with no Databricks connection the pane says how to add one, and gives no verdict', async ($, on) => {
  const answer = failure(
    'The Databricks savings check requires a configured warehouse, but none are set up. Add one with the warehouse_add tool, or via your altimate-code config. Supported types for this operation: databricks.',
  )
  const { clock, toasts } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^altimate-code has no Databricks connection\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /connections\.json/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No savings found|a month$/ })).toBeUndefined()
  expect(toasts.filter(text => text.startsWith('Databricks savings check'))).toEqual([])
  await ui.unmount()
})

test('a refused query says what to ask an admin for, and is no verdict', async ($, on) => {
  const answer = failure('[TABLE_OR_VIEW_NOT_FOUND] The table or view `system`.`compute`.`warehouse_events` cannot be found. SQLSTATE: 42P01')
  const { clock } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^A query was refused: \[TABLE_OR_VIEW_NOT_FOUND\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ask a workspace admin for SELECT/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No savings found/ })).toBeUndefined()
  await ui.unmount()
})

test('without altimate-code the pane says how to install it', async ($, on) => {
  const { clock } = await start($, on, { missingCli: true })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^altimate-code is not installed\.$/ })).toBeDefined()
  await ui.unmount()
})

test('checks that ran and found nothing say so, and still link to the rest', async ($, on) => {
  const answer = { ...ANSWER, metadata: { ...ANSWER.metadata, report: { lookback_days: 7, findings: [], total: { monthly_min: 0, monthly_max: 0, warehouses: 0 } } } }
  const { clock, toasts } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  expect(toasts.at(-1)).toBe('Databricks savings check: no savings found on 5 SQL warehouses.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^No savings found by these 2 checks\.$/ })).toBeDefined()
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe(SIGNUP_URL)
  await ui.unmount()
})

test('a run still waiting when the session ends never writes its report', async ($, on) => {
  let release = () => {}
  const { clock, toasts } = await start($, on, { hold: new Promise<void>(resolve => (release = resolve)) })
  await savings($)
  await clock.settle()
  await $.session.end({ reason: 'clear' } as any)
  release()
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /a month/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Run \/savings/ })).toBeDefined()
  expect(toasts.filter(text => text.startsWith('Databricks savings check'))).toEqual([])
  await ui.unmount()
})

test('a second /savings while one runs does not start another', async ($, on) => {
  let release = () => {}
  const { clock, runs } = await start($, on, { hold: new Promise<void>(resolve => (release = resolve)) })
  await savings($)
  await clock.settle()
  expect((await savings($)).text).toContain('already running')
  release()
  await clock.settle()
  expect(runs.length).toBe(1)
})

test('a terminal too narrow for the pane says so, and the figure still arrives as a notice', async ($, on) => {
  const { clock, toasts } = await start($, on, { isPlaced: false })
  expect((await savings($)).text).toContain('too narrow for the side pane')
  await clock.settle()
  expect(toasts.at(-1)).toContain('$85.17–$106 a month')
})

test('Run again checks the same connection again', async ($, on) => {
  const { clock, runs } = await start($, on)
  await savings($, 'prod_dbx')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'again' })
  await clock.settle()
  expect(runs.map(one => JSON.parse(one.argv[5]!))).toEqual([{ warehouse: 'prod_dbx' }, { warehouse: 'prod_dbx' }])
  await ui.unmount()
})

test('each refusal altimate-code gives is explained in the person\'s terms', () => {
  expect(explain('Warehouse "x" is not configured. Available warehouses: a, b. Pass one of those as the \'warehouse\' parameter, or omit it to use the default.').text).toBe(
    'Warehouse "x" is not configured. Available warehouses: a, b.',
  )
  expect(explain('Connection "dbx" does not go through a SQL warehouse. Its http_path must name one').recovery).toContain('/sql/1.0/warehouses/<id>')
  expect(explain("This altimate-code build's altimate-core has no Databricks savings rules. Update altimate-code, then try again.").text).toContain('no Databricks savings check')
  expect(explain('socket hang up').text).toBe('The savings check failed: socket hang up')
  // The resolver's words for a connection of another type, as altimate-code writes them.
  const other = explain('The Databricks savings check is not available for snowflake warehouses. Try one of: dbx.')
  expect(other.text).toBe('That connection is not a Databricks one.')
  expect(other.recovery).toContain('/savings <connection>')
  expect(explain('No SQL warehouses were found for warehouse abc123 in system.compute.warehouses.').recovery).toContain('within a few hours')
})

test('dollars are whole from $100 and to the cent below it', () => {
  expect(dollars(106.46)).toBe('$106')
  expect(dollars(85.1699)).toBe('$85.17')
  expect(dollars(35142.9)).toBe('$35,143')
})

const BAND = { plugin: 'altimate-code', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as any

test('Draft the fix puts a request for the change in the prompt box, and sends nothing itself', async ($, on) => {
  const { clock, runs, toasts, fills } = await start($, on)
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'fix-0' })
  await clock.settle()
  expect(fills.length).toBe(1)
  expect(fills[0]).toContain('Draft the change for this Databricks savings finding, for me to review. Do not apply or run it.')
  expect(fills[0]).toContain('Warehouse Classic (id wh-classic): Migrate Classic/Pro to Serverless, $85.17–$106 a month at list price.')
  expect(fills[0]).toContain('- CLASSIC SMALL warehouse, 95% idle over 10.8 running hours (2,988 queries)')
  expect(fills[0]).toContain('switch it to a serverless SQL warehouse (enable_serverless_compute true, warehouse_type PRO)')
  expect(fills[0]).toContain('`databricks warehouses edit wh-classic --json`')
  expect(toasts.at(-1)).toContain('in your prompt box')
  // Pressing it runs nothing more against Databricks.
  expect(runs.length).toBe(1)

  await ui.press({ key: 'fix-1' })
  await clock.settle()
  expect(fills[1]).toContain('resize it to 2X-Small (cluster_size "2X-Small")')
  await ui.unmount()
})

test('Draft the fix with no prompt box says so instead of claiming it filled one', async ($, on) => {
  const { clock, toasts, fills } = await start($, on, { canFill: false })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'fix-0' })
  await clock.settle()
  expect(fills).toEqual([])
  expect(toasts.at(-1)).toContain('There is no prompt box to fill here')
  await ui.unmount()
})

test('editing Databricks compute config offers /savings once a session, and Hide clears it', async ($, on) => {
  const files = {
    [`${ROOT}/resources/warehouses.yml`]: 'resources:\n  sql_warehouses:\n    bi:\n      cluster_size: Small\n',
    [`${ROOT}/databricks.yml`]: 'bundle:\n  name: x\n  # clusters below\n',
  }
  const { clock, runs } = await start($, on, { files })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/resources/warehouses.yml`, old_string: 'Small', new_string: 'Medium' })
  await clock.settle()
  let band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^Databricks compute in play: check its SQL warehouses for savings with \/savings/ })).toBeDefined()
  await band.press({ key: 'savings-hide' })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: /Databricks compute in play/ })).toBeUndefined()
  await band.unmount()

  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/databricks.yml`, old_string: 'x', new_string: 'y' })
  await clock.settle()
  band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /Databricks compute in play/ })).toBeUndefined()
  await band.unmount()
  // The offer ran nothing.
  expect(runs).toEqual([])
})

test('after a check, editing config that names a flagged warehouse puts its saving above the prompt', async ($, on) => {
  const files = { [`${ROOT}/infra/warehouses.tf`]: 'resource "databricks_sql_endpoint" "classic" {\n  name = "Classic"\n  cluster_size = "Small"\n}\n' }
  const { clock } = await start($, on, { files })
  await savings($)
  await clock.settle()
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/infra/warehouses.tf`, old_string: 'Small', new_string: 'Medium' })
  await clock.settle()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^Classic: Migrate Classic\/Pro to Serverless, \$85\.17–\$106 a month to save\. \/savings shows why\.$/ })).toBeDefined()
  await band.unmount()
})

test('a databricks CLI command offers the check; other edits and commands do not', async ($, on) => {
  const files = { [`${ROOT}/models/orders.sql`]: 'select * from warehouse_orders', [`${ROOT}/config.yml`]: 'cluster: a' }
  const { clock } = await start($, on, { files })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/orders.sql`, old_string: '*', new_string: 'id' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/config.yml`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'ls warehouses' })
  await clock.settle()
  let band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /Databricks compute in play/ })).toBeUndefined()
  await band.unmount()
  await $.tool.call({ tool: 'Bash', command: 'databricks warehouses list -o json' })
  await clock.settle()
  band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^Databricks compute in play/ })).toBeDefined()
  await band.unmount()
})

test('sizes are written the way the Databricks API takes them', () => {
  expect(apiSize('2X_SMALL')).toBe('2X-Small')
  expect(apiSize('X_SMALL')).toBe('X-Small')
  expect(apiSize('MEDIUM')).toBe('Medium')
  expect(apiSize('4X_LARGE')).toBe('4X-Large')
})
