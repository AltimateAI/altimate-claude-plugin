import { expect, mock, test as kitTest } from 'claude-code/testing'

import {
  columnDrift,
  columnWidths,
  dbtCommand,
  debugInfo,
  failuresFrom,
  failuresFromText,
  logErrors,
  modelContext,
  modelContextNote,
  saysFailed,
  showPreview,
  textTable,
  versionInfo,
} from './dbt-mods-core'

// The dbt helpers on; the lineage half reads no manifest in these tests that it would draw.
// The kit's `$` and `on`, loosely typed: the tests drive engine events with only the fields the helpers read.
const test = (name: string, body: ($: any, on: any) => Promise<void>) => kitTest(name, { options: { dbt_mods: true } }, body as any)

const ROOT = '/proj'
const DBT = `${ROOT}/.venv/bin/dbt`
const ORDERS = `${ROOT}/models/orders.sql`

// A dbt 1.11 manifest, cut to what the helpers read.
const MANIFEST = {
  nodes: {
    'model.shop.stg_orders': { name: 'stg_orders', resource_type: 'model', original_file_path: 'models/staging/stg_orders.sql', config: { materialized: 'view' }, columns: {}, depends_on: { nodes: ['seed.shop.raw_orders'] } },
    'seed.shop.raw_orders': { name: 'raw_orders', resource_type: 'seed', original_file_path: 'seeds/raw_orders.csv', config: {}, columns: {}, depends_on: { nodes: [] } },
    'model.shop.orders': {
      name: 'orders',
      resource_type: 'model',
      original_file_path: 'models/orders.sql',
      relation_name: '"shop"."main"."orders"',
      description: 'One row per order',
      config: { materialized: 'table' },
      tags: ['finance'],
      columns: {
        order_id: { name: 'order_id', description: 'The order', data_type: 'integer' },
        amount: { name: 'amount', description: 'Total amount', data_type: null },
      },
      depends_on: { nodes: ['model.shop.stg_orders'] },
    },
    'model.shop.revenue': { name: 'revenue', resource_type: 'model', original_file_path: 'models/revenue.sql', config: { materialized: 'table' }, columns: {}, depends_on: { nodes: ['model.shop.orders'] } },
    'test.shop.not_null_orders_amount.106140f9fd': { name: 'not_null_orders_amount', resource_type: 'test', original_file_path: 'models/schema.yml', column_name: 'amount', test_metadata: { name: 'not_null' }, depends_on: { nodes: ['model.shop.orders'] } },
    'test.shop.unique_orders_order_id.fed09ac3a6': { name: 'unique_orders_order_id', resource_type: 'test', original_file_path: 'models/schema.yml', column_name: 'order_id', test_metadata: { name: 'unique' }, depends_on: { nodes: ['model.shop.orders'] } },
  },
  parent_map: {
    'seed.shop.raw_orders': [],
    'model.shop.stg_orders': ['seed.shop.raw_orders'],
    'model.shop.orders': ['model.shop.stg_orders'],
    'model.shop.revenue': ['model.shop.orders'],
    'test.shop.not_null_orders_amount.106140f9fd': ['model.shop.orders'],
    'test.shop.unique_orders_order_id.fed09ac3a6': ['model.shop.orders'],
  },
  child_map: {
    'seed.shop.raw_orders': ['model.shop.stg_orders'],
    'model.shop.stg_orders': ['model.shop.orders'],
    'model.shop.orders': ['model.shop.revenue', 'test.shop.not_null_orders_amount.106140f9fd', 'test.shop.unique_orders_order_id.fed09ac3a6'],
    'model.shop.revenue': [],
  },
}

/** dbt show's preview event (Q041) as `--log-format json` writes it, with a log line before it. */
function showLog(rows: Record<string, unknown>[], node: string | null) {
  return [
    JSON.stringify({ data: { msg: '' }, info: { code: 'Z017', level: 'info', msg: '' } }),
    JSON.stringify({ data: { is_inline: node === null, node_name: node ?? 'inline_query', output_format: 'json', preview: JSON.stringify(rows), unique_id: node ? `model.shop.${node}` : null }, info: { code: 'Q041', level: 'info', msg: '…' } }),
  ].join('\n')
}

const BINDER = 'Encountered an error:\nRuntime Error\n  Runtime Error in model orders (models/orders.sql)\n    Binder Error: Values list "orders" does not have a column named "order_dte"'
const errorLog = (msg: string) => JSON.stringify({ data: {}, info: { code: 'Z002', level: 'error', msg: `\u001b[31m${msg}\u001b[0m` } })

// The text Claude's `dbt build` prints when a test errors, as dbt 1.11 writes it.
const BUILD_FAILED = [
  '\u001b[0m06:45:43  \u001b[31mCompleted with 1 error, 0 partial successes, and 0 warnings:\u001b[0m',
  '\u001b[0m06:45:43  \u001b[31mFailure in test not_null_orders_amount (models/schema.yml)\u001b[0m',
  '\u001b[0m06:45:43    Runtime Error in test not_null_orders_amount (models/schema.yml)',
  '  Binder Error: Referenced column "amount" not found in FROM clause!',
  '\u001b[0m06:45:43  Done. PASS=10 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=11',
].join('\n')

const RUN_RESULTS = {
  results: [
    { unique_id: 'model.shop.orders', status: 'success', message: 'OK' },
    { unique_id: 'test.shop.not_null_orders_amount.106140f9fd', status: 'error', message: 'Runtime Error in test not_null_orders_amount (models/schema.yml)\n  Binder Error: Referenced column "amount" not found in FROM clause!', failures: null },
  ],
}

const VERSION = 'Core:\n  - installed: 1.11.6\n  - latest:    1.11.7 - Update available!\n\nPlugins:\n  - duckdb: 1.10.1 - Up to date!\n'
const DEBUG = '06:45:45  python version: 3.13.13\n06:45:45  adapter type: duckdb\n06:45:45    Connection test: [\u001b[32mOK connection ok\u001b[0m]\n06:45:45  All checks passed!'

const BAND = {
  plugin: 'altimate-code',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const RESULTS = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-results',
  props: { title: 'dbt results', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const CHECK = { ...RESULTS, requestId: 'altimate-check', props: { ...RESULTS.props, title: 'dbt check' } } as const

const DOCTOR = { ...RESULTS, requestId: 'altimate-doctor', props: { ...RESULTS.props, title: 'dbt doctor' } } as const

type Options = {
  /** What dbt show answers: rows, or a failure's error lines. */
  show?: { rows?: Record<string, unknown>[]; error?: string; node?: string | null }
  /** File modification times by project-relative path; the manifest's is `target/manifest.json`. */
  mtimes?: Record<string, number>
  interactive?: boolean
  runResultsAt?: number
  now?: number
  profiles?: string
}

/** A dbt project at /proj with its own .venv dbt, and the session beneath the plugin. */
async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on, { now: options.now ?? 1_000 })
  const runs: string[][] = []
  const toasts: string[] = []
  const prompts: string[] = []
  const store = new Map<string, unknown>()
  const mtimes: Record<string, number> = { 'target/manifest.json': 1_000, 'models/orders.sql': 900, 'models/schema.yml': 900, ...options.mtimes }
  const files: Record<string, string> = {
    'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\n",
    'profiles.yml': options.profiles ?? 'shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: shop.duckdb\n',
    'target/manifest.json': JSON.stringify(MANIFEST),
    'target/run_results.json': JSON.stringify(RUN_RESULTS),
    'models/orders.sql': 'select * from {{ ref("stg_orders") }}',
    '.venv/bin/dbt': '#!/proj/.venv/bin/python\nimport sys\n',
  }
  const exists = (path: string) => path.startsWith(`${ROOT}/`) && (path.slice(ROOT.length + 1) in files || Object.keys(files).some(one => one.startsWith(`${path.slice(ROOT.length + 1)}/`)))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.root', () => ({ value: ROOT }))
  const opened: string[] = []
  on('ui.open', (_: unknown, e: { id: string; focus?: boolean }) => {
    opened.push(`${e.id}${e.focus ? ':focus' : ''}`)
    return { value: { isPlaced: true } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('prompt.submit', (_: unknown, e: { text: string; context?: string[] }) => {
    prompts.push([e.text, ...(e.context ?? [])].join('\n---\n'))
    return { text: e.text }
  })
  // The plugin's own /altimate-code:altimate, as Claude Code runs a plugin's command.
  on('command.run', (_: unknown, e: { command: string; args: string }) => {
    prompts.push(`/${e.command} ${e.args}`)
    return { text: '' }
  })
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: exists(e.path) }))
  on('fs.stat', (_: unknown, e: { path: string }) => {
    const rel = e.path.slice(ROOT.length + 1)
    if (!exists(e.path)) throw new Error('ENOENT')
    const isDir = !(rel in files)
    const mtimeMs = rel === 'target/run_results.json' ? (options.runResultsAt ?? 5_000) : (mtimes[rel] ?? 500)
    return { value: { kind: isDir ? 'dir' : 'file', size: files[rel]?.length ?? 0, mtimeMs, isLink: false } }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    const rel = e.path.slice(ROOT.length + 1)
    if (!(rel in files)) throw new Error('ENOENT')
    return { value: files[rel] }
  })
  on('fs.list', (_: unknown, e: { path: string }) => {
    const prefix = e.path === ROOT ? '' : `${e.path.slice(ROOT.length + 1)}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of [...Object.keys(files), ...Object.keys(mtimes)]) {
      if (!path.startsWith(prefix)) continue
      const [head, ...rest] = path.slice(prefix.length).split('/')
      names.set(head!, rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind })) }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    runs.push([...e.argv])
    const [bin, verb] = e.argv
    if (bin === 'printenv') return { value: { exitCode: 0, stdout: '/home/me\n', stderr: '' } }
    if (bin === '/proj/.venv/bin/python') return { value: { exitCode: 0, stdout: 'Python 3.13.13\n', stderr: '' } }
    if (bin !== DBT) return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    if (verb === '--version') return { value: { exitCode: 0, stdout: VERSION, stderr: '' } }
    if (verb === 'debug') return { value: { exitCode: 0, stdout: DEBUG, stderr: '' } }
    if (verb === 'parse') {
      mtimes['target/manifest.json'] = 10_000
      return { value: { exitCode: 0, stdout: 'Performance info: target/perf_info.json', stderr: '' } }
    }
    if (verb === 'show') {
      const show = options.show ?? { rows: [{ order_id: 1, amount: 10 }] }
      if (show.error) return { value: { exitCode: 2, stdout: errorLog(show.error), stderr: '' } }
      const select = e.argv.includes('--select') ? e.argv[e.argv.indexOf('--select') + 1]! : null
      return { value: { exitCode: 0, stdout: showLog(show.rows ?? [], show.node === undefined ? select : show.node), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  // The tool itself, beneath the plugin: Bash answers what the test gives it.
  let bash: { stdout: string; isError?: boolean } = { stdout: '' }
  on('tool.call', (_: unknown, e: { tool: string }) => {
    if (e.tool === 'Bash') return { result: { stdout: bash.stdout, stderr: '', interrupted: false }, ...(bash.isError ? { isError: true, text: bash.stdout } : {}) }
    return { result: { ok: true } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: options.interactive ?? false })
  await clock.settle()
  return { clock, runs, toasts, prompts, store, mtimes, opened, setBash: (next: typeof bash) => void (bash = next) }
}

// ─── What the helpers read from dbt ─────────────────────────────────────────────────────────────

kitTest('dbt show JSON logs give the rows in dbt\'s column order; the text table drops the elided column', () => {
  expect(showPreview(showLog([{ b: 1, a: 'x' }, { b: 2, a: null }], 'orders'))).toEqual({ columns: ['b', 'a'], rows: [[1, 'x'], [2, null]], node: 'orders' })
  expect(showPreview('no preview here')).toBeNull()
  const text = '\u001b[0m06:36:55  Previewing node \'customers\':\n| customer_id | first_name | ... |\n| ----------- | ---------- | --- |\n|           1 | Michael    | ... |\n'
  expect(textTable(text)).toEqual({ columns: ['customer_id', 'first_name'], rows: [['1', 'Michael']] })
})

kitTest('a failed dbt command is read from run_results.json by node name, and from its text when there is none', () => {
  expect(failuresFrom(RUN_RESULTS, MANIFEST)).toEqual([
    {
      id: 'test.shop.not_null_orders_amount.106140f9fd',
      name: 'not_null_orders_amount',
      kind: 'test',
      status: 'error',
      message: 'Runtime Error in test not_null_orders_amount (models/schema.yml)\n  Binder Error: Referenced column "amount" not found in FROM clause!',
      path: 'models/schema.yml',
      failures: null,
    },
  ])
  // Without the manifest, a test's name is still the part before its hash.
  expect(failuresFrom(RUN_RESULTS, null)[0]!.name).toBe('not_null_orders_amount')
  expect(failuresFromText(BUILD_FAILED).map(one => [one.kind, one.name, one.path])).toEqual([['test', 'not_null_orders_amount', 'models/schema.yml']])
  expect(saysFailed(BUILD_FAILED)).toBe(true)
  expect(saysFailed('Done. PASS=11 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=11')).toBe(false)
  expect(logErrors(errorLog(BINDER))).toEqual([BINDER])
})

kitTest('dbt commands are found behind a cd, a venv path or uv run, with their selection; other text is not one', () => {
  expect(dbtCommand('dbt build -s orders')).toEqual({ verb: 'build', select: 'orders', inline: null, limit: null })
  expect(dbtCommand('cd x && .venv/bin/dbt show --select customers --limit 5')).toEqual({ verb: 'show', select: 'customers', inline: null, limit: 5 })
  expect(dbtCommand('uv run dbt --no-use-colors run --select +orders')).toEqual({ verb: 'run', select: '+orders', inline: null, limit: null })
  expect(dbtCommand(`dbt show --inline "select * from {{ ref('orders') }}" --limit 3`)).toEqual({ verb: 'show', select: null, inline: "select * from {{ ref('orders') }}", limit: 3 })
  expect(dbtCommand('echo dbt is great')).toBeNull()
  // A dbt command inside another command's quoted argument is not run.
  expect(dbtCommand('altimate run "Fix the failing test, then re-run `dbt build -s orders`" --agent builder')).toBeNull()
  expect(dbtCommand(`dbt show --inline 'select 1 as "a b"' --limit 2`)).toEqual({ verb: 'show', select: null, inline: 'select 1 as "a b"', limit: 2 })
  expect(dbtCommand('grep dbt README.md')).toBeNull()
})

kitTest('the model context lists columns with their tests, the depth both ways and the materialization', () => {
  const context = modelContext(MANIFEST, 'model.shop.orders')!
  expect(context.upstreamDepth).toBe(2)
  expect(context.downstreamDepth).toBe(1)
  expect(context.parents).toEqual(['stg_orders'])
  expect(context.children).toEqual(['revenue'])
  expect(context.columns).toEqual([
    { name: 'order_id', type: 'integer', description: 'The order', tests: ['unique'] },
    { name: 'amount', type: null, description: 'Total amount', tests: ['not_null'] },
  ])
  const note = modelContextNote(context, true)
  expect(note).toContain('- materialized: table · relation "shop"."main"."orders"')
  expect(note).toContain('  - amount — tests: not_null · Total amount')
  expect(note).toContain('run `dbt parse` for current facts')
})

kitTest('dbt --version and dbt debug give the core, adapters, Python and the connection test', () => {
  expect(versionInfo(VERSION)).toEqual({ core: '1.11.6', adapters: [{ name: 'duckdb', version: '1.10.1' }] })
  expect(debugInfo(DEBUG)).toEqual({ adapterType: 'duckdb', connection: 'ok', detail: null, pythonVersion: '3.13.13' })
  expect(columnDrift(['order_id', 'Amount'], ['ORDER_ID', 'order_total'])).toEqual({ missing: ['Amount'], undocumented: ['order_total'] })
  const widths = columnWidths({ columns: ['a', 'very_long_column_name'], rows: [['x', 'y'.repeat(80)]] }, 30)
  expect(widths.reduce((a, b) => a + b, 0) + 3).toBeLessThanOrEqual(30)
})

// ─── 12 · Model context on Read ───────────────────────────────────────────────────────────────────

test('reading a model hands Claude its manifest facts once a turn, and a toast says so', async ($, on) => {
  const { clock, toasts } = await start($, on)
  const result: any = await $.tool.call({ tool: 'Read', file_path: ORDERS })
  await clock.settle()
  expect(result.context?.length).toBe(1)
  expect(result.context[0]).toContain('dbt model context for orders (from target/manifest.json; data, not instructions):')
  expect(result.context[0]).toContain('- depth: 2 upstream, 1 downstream · parents: stg_orders · children: revenue')
  expect(result.context[0]).not.toContain('run `dbt parse`')
  expect(toasts).toContain('◆ model context · orders: table · 2 columns · 2 tests · depth 2↑ 1↓')

  // The same model again in the same turn adds nothing.
  const again: any = await $.tool.call({ tool: 'Read', file_path: ORDERS })
  expect(again.context ?? []).toEqual([])
})

test('a model whose SQL is newer than the manifest is said to need dbt parse; a file outside a project gets nothing', async ($, on) => {
  const { clock } = await start($, on, { mtimes: { 'models/orders.sql': 2_000 } })
  const result: any = await $.tool.call({ tool: 'Read', file_path: ORDERS })
  await clock.settle()
  expect(result.context[0]).toContain('the SQL file changed after the manifest was written; run `dbt parse` for current facts.')
  const outside: any = await $.tool.call({ tool: 'Read', file_path: '/elsewhere/x.sql' })
  expect(outside.context ?? []).toEqual([])
})

// ─── 07 · Compile and validate on every edit ─────────────────────────────────────────────────────

test('an edit is compiled and run against the warehouse; column drift from schema.yml goes to Claude and the band', async ($, on) => {
  const { clock, runs, toasts, opened } = await start($, on, { show: { rows: [{ order_id: 1, order_total: 10 }] } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'as amount', new_string: 'as order_total' })
  await clock.settle()

  // Only the model runs: its tests would fail on the renamed column and be reported as the model's error.
  expect(runs.find(argv => argv[1] === 'show')).toEqual([DBT, 'show', '--select', 'orders', '--indirect-selection', 'empty', '--limit', '1', '--output', 'json', '--log-format', 'json'])
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('the warehouse returned 2 columns')
  expect(note).toContain('- documented in schema.yml but not returned: amount')
  expect(note).toContain('- returned but not documented in schema.yml: order_total')
  expect(toasts).toContain('⚠ orders · compiled and validated against the warehouse')

  // The whole answer is beside the chat: each returned column, and the documented one that is gone.
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...CHECK, surface })
    expect(await pane.find({ type: 'Text', text: 'Compiles and runs, but its columns differ from schema.yml' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '  returned, not documented' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '  documented, not returned' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'amount' })).toBeDefined()
    await pane.unmount()
  }
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /missing amount · undocumented order_total/ })).toBeDefined()
  // A check that found a problem opens its pane by itself; Details brings it to the front.
  expect(opened).toContain('altimate-check')
  await band.press({ key: 'dbt-check-details' })
  expect(opened).toContain('altimate-check:focus')
  await band.press({ key: 'dbt-check-dismiss' })
  expect(await band.find({ key: 'dbt-check-dismiss' })).toBeUndefined()
  await band.unmount()
})

test('a passing dbt build after the fix takes the edit\'s check off the band', async ($, on) => {
  const { clock, setBash } = await start($, on, { show: { rows: [{ order_id: 1, order_total: 10 }] } })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'as amount', new_string: 'as order_total' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-check-dismiss' })).toBeDefined()
  // A passing test run says nothing about the model's columns: the check stays.
  setBash({ stdout: 'Done. PASS=2 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=2' })
  await $.tool.call({ tool: 'Bash', command: 'dbt test -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-check-dismiss' })).toBeDefined()
  setBash({ stdout: 'Done. PASS=11 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=11' })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-check-dismiss' })).toBeUndefined()
  await band.unmount()
})

test('a model another process fixed is checked again after the next shell command, and the band says so', async ($, on) => {
  const show: Options['show'] = { rows: [{ order_id: 1, order_total: 10 }] }
  const { clock, mtimes, toasts, setBash } = await start($, on, { show })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'as amount', new_string: 'as order_total' })
  await clock.settle()
  // An unrelated command with nothing changed starts no dbt.
  setBash({ stdout: 'ok' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  expect(toasts.some(one => one.includes('checked again'))).toBe(false)

  // altimate-code puts the column back, in its own process.
  show!.rows = [{ order_id: 1, amount: 10 }]
  mtimes['models/orders.sql'] = 50_000
  await $.tool.call({ tool: 'Bash', command: 'altimate run "fix it, then dbt build" --agent builder' })
  await clock.settle()
  expect(toasts).toContain('✓ orders changed · checked again against the warehouse')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /2 columns · match schema\.yml/ })).toBeDefined()
  await band.unmount()
})

test('an edit dbt cannot compile or run tells Claude to fix it, with dbt\'s own error', async ($, on) => {
  const { clock } = await start($, on, { show: { error: BINDER } })
  const result: any = await $.tool.call({ tool: 'Write', file_path: ORDERS, content: 'select order_dte from x' })
  await clock.settle()
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('- FAILED. dbt reported:')
  expect(note).toContain('Binder Error: Values list "orders" does not have a column named "order_dte"')
  expect(note).toContain('Fix the model before going on')
  const pane = await $.ui.mount({ ...CHECK, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'dbt could not compile or run it' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Binder Error: Values list "orders" does not have a column named "order_dte"/ })).toBeDefined()
  await pane.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /Binder Error/ })).toBeDefined()
    await band.unmount()
  }
})

test('an edit of a macro or a file outside a dbt project runs no dbt', async ($, on) => {
  const { clock, runs } = await start($, on)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/macros/cents.sql`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/elsewhere/q.sql', old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show')).toEqual([])
})

// ─── 08 · A failed run, one press from a fix ─────────────────────────────────────────────────────

test('a failed dbt build offers Explain and Fix; a press sends Power User\'s failure prompt with the failed test', async ($, on) => {
  const { clock, toasts, prompts, setBash } = await start($, on)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: '.venv/bin/dbt build -s orders' })
  await clock.settle()
  expect(toasts).toContain('✖ dbt build failed · not_null_orders_amount · Explain or Fix above the prompt')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'not_null_orders_amount' })).toBeDefined()
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]).toContain('The dbt command `.venv/bin/dbt build -s orders` failed. Explain why each failure below happened')
  expect(prompts[0]).toContain('- test not_null_orders_amount (models/schema.yml): Runtime Error in test not_null_orders_amount')
  // The band goes once it is answered.
  expect(await band.find({ key: 'dbt-fix' })).toBeUndefined()
  await band.unmount()
})

test('Fix with Altimate Code hands the failure to altimate-code; a later passing run clears the band', async ($, on) => {
  const { clock, prompts, setBash } = await start($, on)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt test' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'dbt-fix' })
  await clock.settle()
  expect(prompts[0]!.startsWith('/altimate-code:altimate Fix the failing dbt node below, then re-run `dbt test`')).toBe(true)
  await band.unmount()

  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt test' })
  setBash({ stdout: 'Done. PASS=11 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=11' })
  await $.tool.call({ tool: 'Bash', command: 'dbt test' })
  await clock.settle()
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ key: 'dbt-explain' })).toBeUndefined()
  await after.unmount()
})

test('a refused or unrelated command that only names dbt puts nothing above the prompt', async ($, on) => {
  const { clock, toasts, setBash } = await start($, on, { runResultsAt: 1, now: 900_000 })
  setBash({ stdout: 'Permission for this action was denied by the Claude Code auto mode classifier.', isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await $.tool.call({ tool: 'Bash', command: 'altimate run "then dbt build" --agent builder' })
  await clock.settle()
  expect(toasts.filter(one => one.startsWith('✖'))).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('a run_results.json older than the command is not read: the failure comes from dbt\'s text', async ($, on) => {
  const { clock, prompts, setBash } = await start($, on, { runResultsAt: 1, now: 900_000 })
  setBash({ stdout: '\u001b[0m06:45:43  Compilation Error in model orders (models/orders.sql)\n  unexpected \'}\'\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1', isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]).toContain('- model orders (models/orders.sql): Compilation Error')
  await band.unmount()
})

// ─── 09 · Query results in a pane ─────────────────────────────────────────────────────────────────

test('Claude\'s dbt show opens its rows in the results pane; a bookmark is kept across sessions', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ status: 'completed', orders: 67 }, { status: 'placed', orders: 13 }], null) })
  await $.tool.call({ tool: 'Bash', command: `.venv/bin/dbt show --inline "select status, count(*) as orders from {{ ref('stg_orders') }} group by 1" --limit 10 --log-format json` })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...RESULTS, surface })
    expect(await ui.find({ type: 'Text', text: /^select status, count\(\*\) as orders/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 rows · 2 columns · .* · Claude's dbt show/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^completed\s+│ 67/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  await ui.press({ key: 'results-bookmark' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[])[0].bookmarked).toBe(true)
  expect(await ui.find({ type: 'Button', text: /★ Bookmarked/ })).toBeDefined()
  await ui.unmount()
})

test('/dbt-show runs dbt show for a model, and Re-run runs it again; an error shows dbt\'s message', async ($, on) => {
  const { clock, runs } = await start($, on)
  const reply: any = await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  expect(reply.text).toBe('Running dbt show for orders; the rows open in the results pane.')
  expect(runs.filter(argv => argv[1] === 'show')).toEqual([[DBT, 'show', '--select', 'orders', '--indirect-selection', 'empty', '--limit', '50', '--output', 'json', '--log-format', 'json']])

  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 row · 2 columns .* · your query/ })).toBeDefined()
  await ui.press({ key: 'results-rerun' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(2)
  await ui.unmount()
})

test('/dbt-show with SQL runs it inline and keeps it in the history', async ($, on) => {
  const { clock, runs, store } = await start($, on, { show: { error: 'Catalog Error: Table with name nope does not exist!' } })
  await $.command.run({ command: 'dbt-show', args: 'select * from nope' })
  await clock.settle()
  expect(runs.find(argv => argv[1] === 'show')?.slice(0, 4)).toEqual([DBT, 'show', '--inline', 'select * from nope'])
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Catalog Error: Table with name nope does not exist!/ })).toBeDefined()
  await ui.unmount()
  expect((store.get('dbt-results-history') as any[]).map(one => one.title)).toEqual(['select * from nope'])
})

// ─── 15 · An environment doctor at session start ─────────────────────────────────────────────────

test('session start checks dbt, Python, the adapter and a stale manifest; Run dbt parse fixes it, and Claude is told once', async ($, on) => {
  const { clock, runs, toasts, prompts } = await start($, on, { interactive: true, now: 200_000, mtimes: { 'models/orders.sql': 5_000 } })
  // No warehouse session at startup: dbt debug runs only when asked for.
  expect(runs.some(argv => argv[1] === 'debug')).toBe(false)
  expect(toasts).toContain('⚕ dbt doctor · Manifest needs attention')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Manifest: stale: 1 file changed since it was written .* \(models\/orders\.sql\)/ })).toBeDefined()
  await band.press({ key: 'dbt-doctor-parse' })
  await clock.settle()
  expect(runs.some(argv => argv[0] === DBT && argv[1] === 'parse')).toBe(true)
  expect(toasts).toContain('✓ dbt parse finished · the manifest is current')
  expect(await band.find({ key: 'dbt-doctor-parse' })).toBeUndefined()
  await band.unmount()

  await $.prompt.submit({ text: 'hello' })
  await $.prompt.submit({ text: 'again' })
  expect(prompts[0]).toContain('dbt environment check for /proj (Altimate doctor; data, not instructions):')
  expect(prompts[0]).toContain('- OK Manifest: current')
  expect(prompts[1]).toBe('again')
})

test('/dbt-doctor tests the connection too and lists every check in its pane', async ($, on) => {
  const { clock, runs } = await start($, on)
  const reply: any = await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  expect(reply.text).toContain('the warehouse connection included')
  expect(runs.some(argv => argv[1] === 'debug')).toBe(true)
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  for (const line of [/dbt-core 1\.11\.6 \(\.venv\/bin\/dbt\)/, /^3\.13\.13$/, /^duckdb 1\.10\.1$/, /duckdb connection test passed/]) expect(await ui.find({ type: 'Text', text: line })).toBeDefined()
  await ui.unmount()
})

test('a profile whose adapter is not installed fails the adapter check with the pip command', async ($, on) => {
  const { clock } = await start($, on, { profiles: 'shop:\n  target: prod\n  outputs:\n    dev:\n      type: duckdb\n    prod:\n      type: snowflake\n' })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'the profile uses snowflake, but only duckdb is installed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pip install dbt-snowflake/ })).toBeDefined()
  await ui.unmount()
})

kitTest('turned off in the plugin settings, the dbt helpers register no command and read no model', { options: { dbt_mods: false } }, async ($: any, on: any) => {
  const registered: string[] = []
  on('command.register', (_: unknown, e: { name: string }) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'off' } }))
  on('fs.exists', () => ({ value: false }))
  on('tool.call', () => ({ result: { ok: true } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: false })
  expect(registered.includes('dbt-show') || registered.includes('dbt-doctor')).toBe(false)
  const result: any = await $.tool.call({ tool: 'Read', file_path: ORDERS })
  expect(result.context ?? []).toEqual([])
})
