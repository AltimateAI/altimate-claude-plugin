import { expect, mock, test } from 'claude-code/testing'

import { SIGNUP_URL, apiSize, compared, dollars, explain, mentions } from './savings'

const ROOT = '/repo'

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-savings',
  props: { title: 'Databricks savings', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

// `altimate tool run finops_databricks_savings --args '{}' --json --no-daemon` on a live workspace for
// the seven days to 2026-11-18 (warehouse ids replaced).
const ANSWER = {
  status: 'ok',
  title: 'Databricks Savings: $80.64–$101 a month on 1 resource(s)',
  output: 'Databricks savings: 5 SQL warehouses, 0 all-purpose clusters, 0 jobs checked, …',
  metadata: {
    "success": true,
    "window": {
      "start": "2026-11-11",
      "end": "2026-11-18"
    },
    "warehouse": "dbxmega",
    "ran_on": "wh-xs",
    "warehouses_checked": 5,
    "clusters_checked": 0,
    "jobs_checked": 0,
    "skipped": [],
    "warehouses": [
      {
        "id": "wh-xs",
        "name": "ALTIMATE_WH",
        "type": "SERVERLESS",
        "size": "X_SMALL",
        "window_cost": 225.233248
      },
      {
        "id": "wh-classic",
        "name": "Classic",
        "type": "CLASSIC",
        "size": "SMALL",
        "window_cost": 27.544375
      },
      {
        "id": "wh-serverless-t",
        "name": "Serverless-test-wh",
        "type": "SERVERLESS",
        "size": "X_SMALL",
        "window_cost": 0
      },
      {
        "id": "wh-altimate-aut",
        "name": "altimate-autotune-test",
        "type": "SERVERLESS",
        "size": "SMALL",
        "window_cost": 0
      },
      {
        "id": "wh-altimate-wht",
        "name": "altimate_whtest",
        "type": "SERVERLESS",
        "size": "X_SMALL",
        "window_cost": 0
      }
    ],
    "report": {
      "findings": [
        {
          "check_id": "wh_classic_pro_to_serverless",
          "daily_max": 3.36009664971716,
          "daily_min": 2.688077319773728,
          "evidence": {
            "current_dbu_cost": 27.54437282666667,
            "idle_ratio": 0.9540889797360386,
            "kind": "serverless",
            "price_per_dbu": 0.22,
            "projected_serverless_dbu_cost": 4.023696278646552,
            "serverless_price_per_dbu": 0.7,
            "total_query_count": 3107,
            "wall_clock_uptime_hours": 11.0075,
            "warehouse_size": "SMALL",
            "warehouse_type": "CLASSIC",
            "wasted_cost": 23.52067654802012
          },
          "monthly_max": 100.80289949151481,
          "monthly_min": 80.64231959321185,
          "resource_id": "wh-classic",
          "resource_name": "Classic",
          "resource_type": "sql_warehouse",
          "severity": "critical",
          "title": "Migrate Classic/Pro to Serverless"
        },
        {
          "check_id": "wh_oversized",
          "daily_max": 1.8362916666666664,
          "daily_min": 1.0493095238095238,
          "evidence": {
            "available_cores": 32,
            "current_dbu_per_hour": 12,
            "current_size": "SMALL",
            "kind": "over_sized",
            "no_queue_query_pct": 1,
            "no_spill_query_pct": 1,
            "p99_utilization": 0.10725396430349142,
            "parallelism_query_count": 2778,
            "recommended_dbu_per_hour": 4,
            "recommended_size": "2X_SMALL",
            "total_cost": 27.544375,
            "wasted_cost": 18.362916666666667
          },
          "monthly_max": 55.08874999999999,
          "monthly_min": 31.479285714285716,
          "resource_id": "wh-classic",
          "resource_name": "Classic",
          "resource_type": "sql_warehouse",
          "severity": "medium",
          "title": "Over-Sized Warehouse"
        }
      ],
      "lookback_days": 7,
      "total": {
        "monthly_max": 100.80289949151481,
        "monthly_min": 80.64231959321185,
        "resources": 1
      },
      "what_if": [
        {
          "choices": [
            {
              "cores": 0,
              "cores_needed": 6.864253715423451,
              "fits": true,
              "label": "SERVERLESS",
              "monthly_cost": 17.244412622770938,
              "monthly_saving": 100.80290880580048
            },
            {
              "cores": 16,
              "cores_needed": 6.864253715423451,
              "fits": true,
              "label": "X_SMALL",
              "monthly_cost": 59.02366071428571,
              "monthly_saving": 59.02366071428571
            },
            {
              "cores": 8,
              "cores_needed": 6.864253715423451,
              "fits": true,
              "label": "2X_SMALL",
              "monthly_cost": 39.34910714285714,
              "monthly_saving": 78.69821428571427
            }
          ],
          "current_label": "SMALL (CLASSIC)",
          "current_monthly_cost": 118.04732142857142,
          "resource_id": "wh-classic",
          "resource_name": "Classic"
        }
      ]
    },
    "truncated": false
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
  /** What `$.store` holds when the session starts. */
  store?: Record<string, unknown>
}

async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on, { now: options.now ?? Date.parse('2026-11-17T10:00:00Z') })
  const runs: { argv: string[]; env: Record<string, string> | undefined }[] = []
  const toasts: string[] = []
  const fills: string[] = []
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
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
  return { clock, runs, toasts, fills, store }
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
  expect(runs[0]!.env).toEqual({ ALTIMATE_TELEMETRY_DISABLED: 'true', ALTIMATE_ASSESSMENT_MODE: 'true' })
  // The reply in the conversation names no figure, warehouse or workspace: the findings stay in the pane.
  expect(said.text).toContain('Nothing is sent to Altimate')
  expect(said.text).not.toMatch(/\$|Classic|dbxmega/)
  expect(toasts.at(-1)).toBe('Databricks savings check: $80.64–$101 a month on 1 resource.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^\$80\.64–\$101 a month$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Classic · Migrate Classic\/Pro to Serverless · \$80\.64–\$101 a month$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Classic · Over-Sized Warehouse · \$31\.48–\$55\.09 a month$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^CLASSIC SMALL warehouse, 95% idle over 11\.0 running hours \(3,107 queries\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2X-SMALL is enough: 12 → 4 DBU an hour, on \$27\.54 spent over 7 days$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5 SQL warehouses, 0 all-purpose clusters and 0 jobs · the 7 days to 2026-11-18 · connection dbxmega$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /These were 4 of Altimate's 15 Databricks checks/ })).toBeDefined()
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
  // The notice says what is missing, and is no verdict.
  expect(toasts.at(-1)).toMatch(/^Databricks savings check: altimate-code has no Databricks connection\. /)
  expect(toasts.filter(text => /no savings found|a month/.test(text))).toEqual([])
  await ui.unmount()
})

test('a refused query says what to ask an admin for, and is no verdict', async ($, on) => {
  const answer = failure('[TABLE_OR_VIEW_NOT_FOUND] The table or view `system`.`compute`.`warehouse_events` cannot be found. SQLSTATE: 42P01')
  const { clock } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^A query was refused: \[TABLE_OR_VIEW_NOT_FOUND\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /system\.query and system\.lakeflow: ask a workspace admin for SELECT/ })).toBeDefined()
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
  const answer = { ...ANSWER, metadata: { ...ANSWER.metadata, report: { lookback_days: 7, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 }, what_if: [] } } }
  const { clock, toasts } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  expect(toasts.at(-1)).toBe('Databricks savings check: no savings found on 5 SQL warehouses, 0 all-purpose clusters and 0 jobs.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^No savings found by these 4 checks\.$/ })).toBeDefined()
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
  expect(toasts.at(-1)).toContain('$80.64–$101 a month')
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

test('a comparison states the gap between the amounts it shows', () => {
  // Rounded one by one, $125.50 vs $19.05 read "$126 … $19.05, $106 less".
  expect(compared(125.5, 19.05)).toEqual({ was: '$125.50', now: '$19.05', gap: '$106.45' })
  expect(compared(178.4, 0.78)).toEqual({ was: '$178.40', now: '$0.78', gap: '$177.62' })
  // Both from $100: whole dollars, the gap between the whole amounts shown.
  expect(compared(300.4, 120.6)).toEqual({ was: '$300', now: '$121', gap: '$179' })
  expect(compared(118.047, 300)).toEqual({ was: '$118', now: '$300', gap: '$182' })
  expect(compared(1_234.6, 1_000.2)).toEqual({ was: '$1,235', now: '$1,000', gap: '$235' })
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
  expect(fills[0]).toContain('Warehouse Classic (id wh-classic): Migrate Classic/Pro to Serverless, $80.64–$101 a month at list price.')
  expect(fills[0]).toContain('- CLASSIC SMALL warehouse, 95% idle over 11.0 running hours (3,107 queries)')
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
  expect(toasts.at(-1)).toBe("There is no prompt box here. Ask Claude to draft the fix for Classic's Migrate Classic/Pro to Serverless finding from /savings.")
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
  expect(await band.find({ type: 'Text', text: /^Databricks compute in play: check its warehouses, clusters and jobs for savings with \/savings/ })).toBeDefined()
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
  expect(await band.find({ type: 'Text', text: /^Classic: Migrate Classic\/Pro to Serverless, \$80\.64–\$101 a month to save\. \/savings shows why\.$/ })).toBeDefined()
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

test('pressing a what-if size shows what the warehouse would cost there and whether its queries fit', async ($, on) => {
  const { clock } = await start($, on)
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^What if Classic \(\$118 a month now\) were…$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Press a size to see/ })).toBeDefined()
  // The choices, in core's order: serverless, then each smaller size.
  expect(((await ui.find({ key: 'whatif-0-0' })) as any)?.props.label).toBe('SERVERLESS $17.24')
  await ui.press({ key: 'whatif-0-1' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^At X-SMALL: \$59\.02 a month instead of \$118\.05, \$59\.03 less\. Its 16 cores cover the 7 its queries need \(twice what 99% of them use\)\.$/ })).toBeDefined()
  await ui.press({ key: 'whatif-0-0' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^As serverless: \$17\.24 a month instead of \$118\.05, \$100\.81 less: it bills only while queries run\.$/ })).toBeDefined()
  await ui.unmount()
})

test('a size too small for the queries is marked, and pressing it says they would queue', async ($, on) => {
  const answer = JSON.parse(JSON.stringify(ANSWER))
  answer.metadata.report.what_if[0].choices[2].fits = false
  answer.metadata.report.what_if[0].choices[2].cores_needed = 12
  const { clock } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(((await ui.find({ key: 'whatif-0-2' })) as any)?.props.label).toBe('2X-SMALL $39.35 ⚠')
  await ui.press({ key: 'whatif-0-2' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^At 2X-SMALL: \$39\.35 a month, but its 8 cores are short of the 12 its queries need \(twice what 99% of them use\): queries would queue\.$/ })).toBeDefined()
  await ui.unmount()
})

test('a flagged warehouse is remembered, and a later run that finds it resized says what that saved', async ($, on) => {
  // A run on 2026-11-10 flagged Classic as a SMALL CLASSIC that cost $27.54 over its week.
  const store = { 'savings-baseline:dbxmega:wh-classic': { date: '2026-11-10', type: 'CLASSIC', size: 'SMALL', windowCost: 27.54 } }
  const resized = JSON.parse(JSON.stringify(ANSWER))
  const classic = resized.metadata.warehouses.find((one: any) => one.id === 'wh-classic')
  classic.size = 'X_SMALL'
  classic.window_cost = 13.77
  const { clock } = await start($, on, { answer: resized, store })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Classic: SMALL CLASSIC → X-SMALL CLASSIC since 2026-11-10\. \$118\.03 a month then, \$59\.01 now: \$59\.02 a month saved\.$/ })).toBeDefined()
  await ui.unmount()
})

test('the first run that flags a warehouse keeps what it is, and an unflagged one is not kept', async ($, on) => {
  const { clock, store } = await start($, on, { now: Date.parse('2026-11-18T10:00:00Z') })
  await savings($)
  await clock.settle()
  expect(store.get('savings-baseline:dbxmega:wh-classic')).toEqual({ date: '2026-11-18', type: 'CLASSIC', size: 'SMALL', windowCost: 27.544375 })
  expect(store.has('savings-baseline:dbxmega:wh-xs')).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / since / })).toBeUndefined()
  await ui.unmount()
})

const IDLE_CLUSTER = {
  check_id: 'ap_idle_cluster',
  title: 'Idle Cluster Detection',
  resource_type: 'cluster',
  resource_id: '0101-abc',
  resource_name: 'shared-analytics',
  severity: 'critical',
  daily_min: 25.5,
  daily_max: 51,
  monthly_min: 765,
  monthly_max: 1530,
  evidence: { kind: 'idle_cluster', idle_pattern: 'zombie', idle_ratio: 0.85, auto_termination_minutes: null, active_days: 5, avg_cpu_active_pct: 8, peak_cpu_active_pct: 30, total_cost: 700, wasted_cost: 595 },
}

const JOB = {
  check_id: 'jobs_on_all_purpose_compute',
  title: 'Job Running on All-Purpose Compute',
  resource_type: 'job',
  resource_id: '9001',
  resource_name: 'nightly_orders',
  severity: 'high',
  daily_min: 62.34,
  daily_max: 93.51,
  monthly_min: 1870.2,
  monthly_max: 2805.3,
  evidence: { kind: 'job_on_all_purpose', trigger_type: 'PERIODIC', run_count: 28, all_purpose_share: 1, job_share_of_cluster: 1, all_purpose_rate_per_dbu: 0.55, jobs_rate_per_dbu: 0.15, jobs_rate_estimated: false, job_all_purpose_cost: 1000, wasted_cost: 727.27 },
}

test('idle clusters and jobs on all-purpose compute get their own evidence and fix requests, and a skipped check is named', async ($, on) => {
  const answer = JSON.parse(JSON.stringify(ANSWER))
  answer.metadata.clusters_checked = 3
  answer.metadata.jobs_checked = 12
  answer.metadata.skipped = [{ check: 'Job Running on All-Purpose Compute', reason: 'INSUFFICIENT_PERMISSIONS' }]
  answer.metadata.report = { lookback_days: 7, findings: [JOB, IDLE_CLUSTER], total: { monthly_min: 1870.2, monthly_max: 2805.3, resources: 2 }, what_if: [] }
  const { clock, fills } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^5 SQL warehouses, 3 all-purpose clusters and 12 jobs · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^nightly_orders · Job Running on All-Purpose Compute · \$1,870–\$2,805 a month$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^28 runs \(periodic\), 100% of its cost on all-purpose compute, 100% of its cluster's$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^All-purpose cluster 85% idle across 5 active days \(zombie\), average worker CPU 8%, peak 30%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Not checked \(the connection cannot read their system tables\): Job Running on All-Purpose Compute\.$/ })).toBeDefined()
  await ui.press({ key: 'fix-0' })
  await ui.press({ key: 'fix-1' })
  await clock.settle()
  expect(fills[0]).toContain('Job nightly_orders (id 9001)')
  expect(fills[0]).toContain('give its tasks a new_cluster (or job_cluster_key) instead of existing_cluster_id')
  expect(fills[0]).toContain('`databricks jobs reset 9001 --json`')
  expect(fills[1]).toContain('Cluster shared-analytics (id 0101-abc)')
  expect(fills[1]).toContain('set autotermination_minutes to 15, or terminate it if nobody needs it')
  expect(fills[1]).toContain('`databricks clusters edit 0101-abc --json`')
  expect(fills[1]).toContain('If this repository defines it (Terraform databricks_cluster, a cluster policy, or JSON), edit that definition; otherwise write the JSON for `databricks clusters edit 0101-abc --json`. Say what the change does.')
  await ui.unmount()
})

test('a databricks command after cd or an environment assignment offers the check too', async ($, on) => {
  const { clock } = await start($, on)
  await $.tool.call({ tool: 'Bash', command: 'cd infra && DATABRICKS_HOST=https://x databricks bundle deploy' })
  await clock.settle()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^Databricks compute in play/ })).toBeDefined()
  await band.unmount()
})

test('a resource is named in a file only as a whole word', () => {
  expect(mentions('name = "dev"', 'dev')).toBe(true)
  expect(mentions('warehouse_id = "a3688f261647f580"', 'a3688f261647f580')).toBe(true)
  expect(mentions('resource "aws_iot" "devices" {}', 'dev')).toBe(false)
  expect(mentions('bucket = "etl_bucket"', 'etl')).toBe(false)
  expect(mentions('name = "dev-2"', 'dev')).toBe(false)
  expect(mentions('cost (USD)', '(USD)')).toBe(true)
  expect(mentions('anything', ' ')).toBe(false)
})

test('when checks were skipped and none found anything, the verdict is only for the checks that ran', async ($, on) => {
  const answer = JSON.parse(JSON.stringify(ANSWER))
  answer.metadata.skipped = [{ check: 'Job Running on All-Purpose Compute', reason: 'INSUFFICIENT_PERMISSIONS' }]
  answer.metadata.report = { lookback_days: 7, findings: [], total: { monthly_min: 0, monthly_max: 0, resources: 0 }, what_if: [] }
  const { clock, toasts } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  expect(toasts.at(-1)).toBe('Databricks savings check: no savings found on 5 SQL warehouses, 0 all-purpose clusters and 0 jobs; 1 of the 4 checks could not run.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^No savings found by the 3 of 4 checks that ran\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^No savings found by these 4 checks/ })).toBeUndefined()
  await ui.unmount()
})

test('a query that read only its first 10,000 rows is named in the pane', async ($, on) => {
  const answer = JSON.parse(JSON.stringify(ANSWER))
  answer.metadata.limited = ['jobs']
  const { clock } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Only the first 10,000 jobs were read; any beyond them were not checked\.$/ })).toBeDefined()
  await ui.unmount()
})

test('the band never starts a second run while one is going', async ($, on) => {
  const options: any = { files: { [`${ROOT}/infra/warehouses.tf`]: 'resource "databricks_sql_endpoint" "classic" { name = "Classic" }' } }
  const { clock, runs } = await start($, on, options)
  await savings($)
  await clock.settle()
  // A second run that does not finish yet.
  let release = () => {}
  options.hold = new Promise<void>(done => (release = done))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'again' })
  await clock.settle()
  expect(runs.length).toBe(2)
  // An edit that names a flagged warehouse brings the band back; its Run does not start a third.
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/infra/warehouses.tf`, old_string: 'Classic', new_string: 'Classic' })
  await clock.settle()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^Classic: / })).toBeDefined()
  await band.press({ key: 'savings-run' })
  await clock.settle()
  expect(runs.length).toBe(2)
  await band.unmount()
  release()
  await clock.settle()
  await ui.unmount()
})

test('the first baseline stays: a second run after a resize still says what changed since then', async ($, on) => {
  const store = { 'savings-baseline:dbxmega:wh-classic': { date: '2026-11-10', type: 'CLASSIC', size: 'SMALL', windowCost: 27.54 } }
  const resized = JSON.parse(JSON.stringify(ANSWER))
  const classic = resized.metadata.warehouses.find((one: any) => one.id === 'wh-classic')
  classic.size = 'X_SMALL'
  classic.window_cost = 13.77
  const started = await start($, on, { answer: resized, store })
  await savings($)
  await started.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'again' })
  await started.clock.settle()
  expect(started.runs.length).toBe(2)
  expect(started.store.get('savings-baseline:dbxmega:wh-classic')).toEqual(store['savings-baseline:dbxmega:wh-classic'])
  expect(await ui.find({ type: 'Text', text: /^Classic: SMALL CLASSIC → X-SMALL CLASSIC since 2026-11-10\./ })).toBeDefined()
  await ui.unmount()
})

test('a serverless choice that would cost more says so, in the warning colour', async ($, on) => {
  const answer = JSON.parse(JSON.stringify(ANSWER))
  const serverless = answer.metadata.report.what_if[0].choices[0]
  serverless.monthly_cost = 300
  serverless.monthly_saving = answer.metadata.report.what_if[0].current_monthly_cost - 300
  const { clock } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'whatif-0-0' })
  await clock.settle()
  const line = (await ui.find({ type: 'Text', text: /^As serverless: \$300 a month instead of \$118, \$182 more: / })) as any
  expect(line).toBeDefined()
  expect(line.props.color).toBe('warning')
  await ui.unmount()
})

test('Terraform that is not about Databricks gets no offer; a job is not named by its numeric id', async ($, on) => {
  const files = {
    [`${ROOT}/infra/eks.tf`]: 'resource "aws_eks_cluster" "main" { name = "main" }',
    [`${ROOT}/infra/net.tf`]: 'resource "databricks_sql_endpoint" "bi" { name = "BI" }',
  }
  const { clock } = await start($, on, { files })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/infra/eks.tf`, old_string: 'main', new_string: 'main' })
  await clock.settle()
  let band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /Databricks compute in play/ })).toBeUndefined()
  await band.unmount()
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/infra/net.tf`, old_string: 'BI', new_string: 'BI' })
  await clock.settle()
  band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^Databricks compute in play/ })).toBeDefined()
  await band.unmount()
})

test('across several workspaces the pane counts them and names each finding\'s workspace, and so does the fix request', async ($, on) => {
  const answer = JSON.parse(JSON.stringify(ANSWER))
  answer.metadata.warehouses.forEach((one: any, at: number) => (one.workspace_id = at === 0 ? '2056943136844690' : '7474657820801318'))
  answer.metadata.report.findings.forEach((one: any) => (one.workspace_id = '2056943136844690'))
  const { clock, fills } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^5 SQL warehouses, 0 all-purpose clusters and 0 jobs in 2 workspaces · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Classic \(workspace 2056943136844690\) · Migrate Classic\/Pro to Serverless · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Databricks checks, on 2 workspaces\./ })).toBeDefined()
  await ui.press({ key: 'fix-0' })
  await clock.settle()
  expect(fills[0]).toContain('(id wh-classic, workspace 2056943136844690)')
  await ui.unmount()
})

test('a failed run also comes as a notice, for a terminal too narrow for the pane', async ($, on) => {
  const answer = failure('[TABLE_OR_VIEW_NOT_FOUND] The table or view `system`.`compute`.`warehouse_events` cannot be found. SQLSTATE: 42P01')
  const { clock, toasts } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  expect(toasts.at(-1)).toMatch(/^Databricks savings check: A query was refused: \[TABLE_OR_VIEW_NOT_FOUND\].* ask a workspace admin for SELECT/)
})

test('an altimate-code too old to have `tool run` says to update, not "failed"', () => {
  const usage = 'altimate-code [project]            start altimate-code tui\n\nCommands:\n  altimate-code completion           generate shell completion script\n  altimate-code mcp                  manage MCP servers'
  expect(explain(usage)).toEqual({ text: 'This altimate-code has no Databricks savings check.', recovery: 'Update altimate-code (`altimate upgrade`), then run /savings again.' })
})

test('a finding in a workspace with no SQL warehouse still counts that workspace', async ($, on) => {
  const answer = JSON.parse(JSON.stringify(ANSWER))
  answer.metadata.warehouses.forEach((one: any) => (one.workspace_id = '111'))
  answer.metadata.report.findings[0].workspace_id = '222'
  const { clock } = await start($, on, { answer })
  await savings($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / in 2 workspaces · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Classic \(workspace 222\) · / })).toBeDefined()
  await ui.unmount()
})
