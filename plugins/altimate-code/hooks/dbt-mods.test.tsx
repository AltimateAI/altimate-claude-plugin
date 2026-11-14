import { expect, mock, test as kitTest } from 'claude-code/testing'

import {
  columnDrift,
  columnWidths,
  dbtCommand,
  dbtCommands,
  dbtVerdict,
  hashedEnv,
  sha256Hex,
  debugInfo,
  failuresFrom,
  failuresFromText,
  logErrors,
  modelContext,
  modelContextNote,
  nodeForFile,
  projectPaths,
  replayArgv,
  saysFailed,
  shellWords,
  targetPath,
  showPreview,
  textTable,
  versionInfo,
} from './dbt-mods-core'
import { MANIFEST_SLICE } from './dbt-mods'

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
      patch_path: 'shop://models/schema.yml',
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
  props: { title: 'Query results', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const CHECK = { ...RESULTS, requestId: 'altimate-check', props: { ...RESULTS.props, title: 'dbt check' } } as const

const DOCTOR = { ...RESULTS, requestId: 'altimate-doctor', props: { ...RESULTS.props, title: 'dbt doctor' } } as const

type Options = {
  /** What dbt show answers: rows, or a failure's error lines. */
  show?: { rows?: Record<string, unknown>[]; error?: string; node?: string | null; onlyName?: string; mustInclude?: string }

  /** File modification times by project-relative path; the manifest's is `target/manifest.json`. */
  mtimes?: Record<string, number>
  interactive?: boolean
  runResultsAt?: number
  now?: number
  profiles?: string
  /** The manifest's size: over 4 MiB it is read through the project's Python. */
  manifestSize?: number
  /** `dbt --version` output. */
  version?: string
  /** Environment variables `printenv` answers. */
  env?: Record<string, string>
  /** What the plugin's store held from an earlier session. */
  stored?: Record<string, unknown>
  /** Extra project files, by project-relative path. */
  files?: Record<string, string>
  /** No manifest until dbt show writes this one. */
  manifestAfterShow?: unknown
  /** The first Edit waits for this before its result returns. */
  holdEdit?: Promise<void>
  /** The first read of Claude's shell folder waits for this. */
  holdCwd?: Promise<void>
  /** The first dbt show waits for this. */
  holdShow?: Promise<void>
  /** The dbt shows that run before the held one. */
  holdShowAfter?: number
  /** Folders that exist but cannot be listed. */
  unreadable?: string[]
  /** Runs while Claude's shell command is running, before its result returns. */
  duringBash?: () => Promise<void>
  /** `dbt deps` fails with this message. */
  depsFails?: string
  /** A file whose stat waits for `until` while it is set. */
  statGate?: { path: string; until?: Promise<void> }
  /** The project's artifact folder, when not `target`. */
  target?: string
  /** Where Claude's shell is, when not the session folder. */
  cwd?: string
  /** The session's root folder, when not the project. */
  sessionRoot?: string
}

/** A dbt project at /proj with its own .venv dbt, and the session beneath the plugin. */
async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on, { now: options.now ?? 1_000 })
  const runs: string[][] = []
  const cwds: string[] = []
  const toasts: string[] = []
  const prompts: string[] = []
  const store = new Map<string, unknown>(Object.entries(options.stored ?? {}))
  const mtimes: Record<string, number> = { 'target/manifest.json': 1_000, 'models/orders.sql': 900, 'models/schema.yml': 900, ...options.mtimes }
  const files: Record<string, string> = {
    'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\n",
    'profiles.yml': options.profiles ?? 'shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: shop.duckdb\n',
    'target/manifest.json': JSON.stringify(MANIFEST),
    'target/run_results.json': JSON.stringify(RUN_RESULTS),
    'models/orders.sql': 'select * from {{ ref("stg_orders") }}',
    'models/schema.yml': 'version: 2\n',
    // Every file the manifest lists, so the doctor finds none deleted.
    'models/staging/stg_orders.sql': 'select 1',
    'models/revenue.sql': 'select 1',
    'seeds/raw_orders.csv': 'id',
    '.venv/bin/dbt': '#!/proj/.venv/bin/python\nimport sys\n',
    '.venv/bin/python': '',
    ...options.files,
  }
  if (options.manifestAfterShow && !options.files?.['target/manifest.json']) delete files['target/manifest.json']
  if (options.target) {
    files[`${options.target}/manifest.json`] = files['target/manifest.json']!
    delete files['target/manifest.json']
    mtimes[`${options.target}/manifest.json`] = mtimes['target/manifest.json']!
  }
  const exists = (path: string) => path === ROOT || (path.startsWith(`${ROOT}/`) && (path.slice(ROOT.length + 1) in files || Object.keys(files).some(one => one.startsWith(`${path.slice(ROOT.length + 1)}/`))))
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.root', () => ({ value: options.sessionRoot ?? ROOT }))
  // Where Claude's shell is: the session folder unless a test moved it.
  let cwdHeld = false
  on('session.cwd', async () => {
    if (options.holdCwd && !cwdHeld) {
      cwdHeld = true
      await options.holdCwd
    }
    return { value: options.cwd ?? ROOT }
  })
  const opened: string[] = []
  const sizes: { id: string; title: string; columns?: number; rows?: number }[] = []
  on('ui.open', (_: unknown, e: { id: string; title: string; columns?: number; rows?: number; focus?: boolean }) => {
    opened.push(`${e.id}${e.focus ? ':focus' : ''}`)
    sizes.push({ id: e.id, title: e.title, columns: e.columns, rows: e.rows })
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
  on('fs.stat', async (_: unknown, e: { path: string }) => {
    if (options.statGate?.until && e.path === `${ROOT}/${options.statGate.path}`) await options.statGate.until
    const rel = e.path.slice(ROOT.length + 1)
    if (!exists(e.path)) throw new Error('ENOENT')
    const isDir = !(rel in files)
    const mtimeMs = rel === 'target/run_results.json' ? (options.runResultsAt ?? 5_000) : (mtimes[rel] ?? 500)
    const size = rel === 'target/manifest.json' && options.manifestSize ? options.manifestSize : (files[rel]?.length ?? 0)
    return { value: { kind: isDir ? 'dir' : 'file', size, mtimeMs, isLink: false } }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    const rel = e.path.slice(ROOT.length + 1)
    if (!(rel in files)) throw new Error('ENOENT')
    return { value: files[rel] }
  })
  on('fs.list', (_: unknown, e: { path: string }) => {
    if (options.unreadable?.includes(e.path.slice(ROOT.length + 1))) throw new Error('EACCES')
    const prefix = e.path === ROOT ? '' : `${e.path.slice(ROOT.length + 1)}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of [...Object.keys(files), ...Object.keys(mtimes)]) {
      if (!path.startsWith(prefix)) continue
      const [head, ...rest] = path.slice(prefix.length).split('/')
      names.set(head!, rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind })) }
  })
  let held = false
  let shows = 0
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    runs.push([...e.argv])
    cwds.push(e.init?.cwd ?? '')
    // The first dbt show waits until the test lets it go.
    if (options.holdShow && !held && e.argv.includes('show') && shows++ >= (options.holdShowAfter ?? 0)) {
      held = true
      await options.holdShow
    }
    const [bin, verb] = e.argv
    if (bin === 'printenv') {
      const value = { HOME: '/home/me', ...options.env }[verb as string]
      return { value: { exitCode: value ? 0 : 1, stdout: value ? `${value}\n` : '', stderr: '' } }
    }
    // The project's Python: its version, or the slice of a manifest too big to read here.
    if (bin === '/proj/.venv/bin/python' && verb === '-c') return { value: { exitCode: 0, stdout: JSON.stringify({ nodes: MANIFEST.nodes, parent_map: MANIFEST.parent_map, child_map: MANIFEST.child_map }), stderr: '' } }
    if (bin === '/proj/.venv/bin/python') return { value: { exitCode: 0, stdout: 'Python 3.13.13\n', stderr: '' } }
    if (bin !== DBT) return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    if (verb === '--version') return { value: { exitCode: 0, stdout: options.version ?? VERSION, stderr: '' } }
    if (verb === 'debug') return { value: { exitCode: 0, stdout: DEBUG, stderr: '' } }
    if (verb === 'deps' && options.depsFails) return { value: { exitCode: 1, stdout: '', stderr: options.depsFails } }
    if (verb === 'parse') {
      mtimes['target/manifest.json'] = 10_000
      return { value: { exitCode: 0, stdout: 'Performance info: target/perf_info.json', stderr: '' } }
    }
    if (verb === 'show') {
      const show = options.show ?? { rows: [{ order_id: 1, amount: 10 }] }
      if (options.manifestAfterShow) {
        files['target/manifest.json'] = JSON.stringify(options.manifestAfterShow)
        mtimes['target/manifest.json'] = (mtimes['target/manifest.json'] ?? 1_000) + 1
      }
      // dbt selects a model by its name: the one the test's manifest gives the file, if it gave one.
      const asked = e.argv[e.argv.indexOf('--select') + 1]
      if (show.onlyName && asked !== show.onlyName) return { value: { exitCode: 0, stdout: JSON.stringify({ info: { code: 'Q043', level: 'warn', msg: 'No nodes selected!' } }), stderr: '' } }
      // dbt prints a node's preview only when its name is in the selection string.
      if (show.mustInclude && !asked?.includes(show.mustInclude)) return { value: { exitCode: 0, stdout: JSON.stringify({ info: { code: 'Q043', level: 'warn', msg: 'No nodes selected!' } }), stderr: '' } }
      // A comma is an intersection: every bare name in it must be the node's own name, or nothing is selected.
      const nodeName = show.node === undefined ? (asked?.startsWith('path:') ? asked.slice(5).split(',')[0]!.split('/').pop()!.replace(/\.sql$/, '') : asked) : show.node
      if (asked?.includes(',') && nodeName && asked.split(',').some(term => !term.includes(':') && term !== nodeName)) return { value: { exitCode: 0, stdout: JSON.stringify({ info: { code: 'Q043', level: 'warn', msg: 'No nodes selected!' } }), stderr: '' } }
      if (show.error) return { value: { exitCode: 2, stdout: errorLog(show.error), stderr: '' } }
      // A selection that matches no node: dbt exits 0 and previews nothing.
      if (show.node === 'none') return { value: { exitCode: 0, stdout: JSON.stringify({ info: { code: 'Q043', level: 'warn', msg: 'No nodes selected!' } }), stderr: '' } }
      // dbt names the node it shows: `path:models/x.sql,package:p` selects the model x.
      const selected = e.argv.includes("--select") ? e.argv[e.argv.indexOf("--select") + 1]! : null
      const select = selected?.startsWith("path:") ? selected.slice(5).split(',')[0]!.split('/').pop()!.replace(/\.sql$/, '') : selected
      return { value: { exitCode: 0, stdout: showLog(show.rows ?? [], show.node === undefined ? select : show.node), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  // The tool itself, beneath the plugin: Bash answers what the test gives it.
  let editHeld = false
  let bash: { stdout: string; isError?: boolean } = { stdout: '' }
  on('tool.call', async (_: unknown, e: { tool: string }) => {
    if (e.tool === 'Bash' && options.duringBash) await options.duringBash()
    if (e.tool === 'Edit' && options.holdEdit && !editHeld) {
      editHeld = true
      await options.holdEdit
    }
    if (e.tool === 'Bash') return { result: { stdout: bash.stdout, stderr: '', interrupted: false }, ...(bash.isError ? { isError: true, text: bash.stdout } : {}) }
    return { result: { ok: true } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: options.interactive ?? false })
  await clock.settle()
  return { clock, runs, cwds, toasts, prompts, store, mtimes, opened, sizes, files, setBash: (next: typeof bash) => void (bash = next) }
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
  expect(dbtCommand('dbt build -s orders')).toEqual({ verb: 'build', select: 'orders', inline: null, limit: null, options: [], identity: [], at: 0, end: 9, argv: ['dbt', 'build', '-s', 'orders'], replayable: true, env: [] })
  expect(dbtCommand('cd x && .venv/bin/dbt show --select customers --limit 5')).toEqual({ verb: 'show', select: 'customers', inline: null, limit: 5, options: [], identity: ['--limit 5'], at: 8, end: 26, argv: ['.venv/bin/dbt', 'show', '--select', 'customers', '--limit', '5'], replayable: true, env: [] })
  // Redirections are the shell's: they are neither selection nor argv.
  expect(dbtCommand('dbt show -s orders 2>&1 | tail -20')?.argv).toEqual(['dbt', 'show', '-s', 'orders'])
  expect(dbtCommand('dbt run -s orders > out.txt 2> err.txt')?.select).toBe('orders')
  // What the shell expanded cannot be repeated word for word.
  expect(dbtCommand('DBT_PROFILES_DIR=. dbt show -s x')?.replayable).toBe(false)
  expect(dbtCommand('dbt show --target $T -s x')?.replayable).toBe(false)
  // A command split with `\` across lines is one command.
  expect(dbtCommand('dbt build \\\n  --select stg_x \\\n  --limit 10')).toEqual({ verb: 'build', select: 'stg_x', inline: null, limit: 10, options: [], identity: ['--limit 10'], at: 0, end: 9, argv: ['dbt', 'build', '--select', 'stg_x', '--limit', '10'], replayable: true, env: [] })
  // A redirection inside quoted SQL is SQL.
  expect(dbtCommand('dbt show --inline "select 1 as \\"2>1\\"" -s x')?.inline).toBe('select 1 as "2>1"')
  // Comments and background `&` end it; anything the shell would expand or change turns Re-run off.
  expect(dbtCommand('dbt show -s a # preview')?.select).toBe('a')
  expect(dbtCommand('dbt run -s a &')?.argv).toEqual(['dbt', 'run', '-s', 'a'])
  for (const command of ['env DBT_TARGET=prod dbt show -s a', 'export X=1 && dbt show -s a', 'uv run --env-file .env dbt show -s a', 'dbt show -s a --profiles-dir ~/.dbt']) expect(dbtCommand(command)?.replayable).toBe(false)
  expect(dbtCommand('source .venv/bin/activate && dbt show -s orders')?.replayable).toBe(true)
  // Expansion inside double quotes counts; so do globs, sourced env files and anything else before dbt.
  for (const command of ['dbt show -s m --target "$T"', 'dbt show --inline "select * from $TABLE"', 'dbt show --inline "select `date`"', 'dbt show -s stg_*', 'set -a; . ./.env; dbt show -s m', 'source /other/venv/bin/activate && dbt show -s m', 'cd ~/x && dbt show -s m']) expect(dbtCommand(command)?.replayable).toBe(false)
  // Single-quoted text is literal to the shell, but a $ there is still left to dbt unexpanded: Re-run stays off.
  expect(dbtCommand("cd sub && dbt show -s m")?.replayable).toBe(true)
  expect(dbtCommand('uv run dbt show -s m')?.replayable).toBe(true)
  expect(dbtCommand('uv run --env-file .env dbt show -s m')?.replayable).toBe(false)
  // An escaped separator is part of the argument, as the shell passes it.
  expect(dbtCommand('dbt show --inline select\\ 1\\; -s x')?.inline).toBe('select 1;')
  // The environment set for it is part of where it ran.
  expect(dbtCommand('DBT_TARGET=prod dbt run -s orders')?.env).toEqual([hashedEnv('DBT_TARGET=prod')])
  // Only real assignments: a word with `=` in another command is not one.
  expect(dbtCommand('echo a=b; git commit -m x=1 && dbt run -s o')?.env).toEqual([])
  expect(dbtCommand('export A=1 B=2; dbt run -s o')?.env).toEqual([hashedEnv('A=1'), hashedEnv('B=2')].sort())
  // The value dbt runs with: the command's own prefix overrides an earlier export.
  expect(dbtCommand('export DBT_TARGET=dev; DBT_TARGET=prod dbt run -s o')?.env).toEqual([hashedEnv('DBT_TARGET=prod')])
  expect(dbtCommand('export DBT_TARGET=prod; DBT_TARGET=dev dbt run -s o')?.env).toEqual([hashedEnv('DBT_TARGET=dev')])
  // An installed package's model at the same path is not the project's.
  const shared = { metadata: { project_name: 'shop' }, nodes: { 'model.pkg.orders': { resource_type: 'model', package_name: 'pkg', original_file_path: 'models/orders.sql' }, 'model.shop.orders': { resource_type: 'model', package_name: 'shop', original_file_path: 'models/orders.sql' } } }
  expect(nodeForFile(shared, 'models/orders.sql')?.id).toBe('model.shop.orders')
  // dbt show's two other output forms: text preview in JSON logs, and a JSON block in text logs.
  expect(showPreview(JSON.stringify({ data: { output_format: 'text', node_name: 'm', preview: '| a | b |\n| - | - |\n| 1 | 2 |' }, info: { code: 'Q041' } }))?.rows).toEqual([['1', '2']])
  expect(showPreview('06:00:00  Previewing node \'m\':\n{\n  "node": "m",\n  "show": [\n    {"a": 1}\n  ]\n}\n')?.columns).toEqual(['a'])
  // A prefix applies only to its own command.
  expect(dbtCommand('A=1 echo hi; dbt run -s o')?.env).toEqual([])
  expect(targetPath("target-path: \"{{ env_var('T', 'target') }}\"\n")).toBe('target')
  expect(targetPath('target-path: /abs/build\n')).toBe('/abs/build')
  // A `#` inside a quoted path is part of the path.
  expect(projectPaths("model-paths: ['models#v2']\n")).toContain('models#v2')
  expect(dbtCommand('uv run dbt --no-use-colors run --select +orders')?.select).toBe('+orders')
  expect(dbtCommand(`dbt show --inline "select * from {{ ref('orders') }}" --limit 3`)?.inline).toBe("select * from {{ ref('orders') }}")
  // `=` forms, and the flags a re-run keeps; nothing is read past the shell's next command.
  const piped = dbtCommand(`dbt show --select=orders --limit=2 -t prod --vars '{"x": 1}' | tail -3 --limit 9`)
  expect([piped?.select, piped?.limit, piped?.options]).toEqual(['orders', 2, ['--target', 'prod', '--vars', '{"x": 1}']])
  // Flags before the verb and repeated flags keep their order; escapes are decoded as the shell does.
  const replay = dbtCommand(`dbt --target prod show -t dev --target qa -s orders --inline "select \\"id\\"" --log-format json -q`)!
  expect(replay.options).toEqual(['--target', 'prod', '--target', 'dev', '--target', 'qa'])
  expect(replay.inline).toBe('select "id"')
  expect(replayArgv(replay.argv, 7)).toEqual(['dbt', '--target', 'prod', 'show', '-t', 'dev', '--target', 'qa', '-s', 'orders', '--inline', 'select "id"', '--limit', '7', '--output', 'json', '--log-format', 'json'])
  expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g`)).toEqual(['a', 'b c', 'd "e"', 'f g'])
  // A flag inside quoted SQL is SQL, not a flag.
  const quoted = dbtCommand(`dbt show --inline "select '-t prod' as x, '--limit 1000' as y" --limit 4`)
  expect([quoted?.options, quoted?.limit]).toEqual([[], 4])
  // Every selection value, and an exclusion or selector, which make it less than the whole project.
  expect(dbtCommand('dbt run -s a b --threads 4')?.select).toBe('a b')
  expect(dbtCommand('dbt run --exclude orders')?.select).toBe('--exclude orders')
  expect(dbtCommand('dbt build --selector nightly')?.select).toBe('--selector nightly')
  // A verb inside the executable's path is not another invocation.
  for (const command of ['/home/run/proj/.venv/bin/dbt run -s a', '/Users/me/shows/p/.venv/bin/dbt show -s orders', './build/.venv/bin/dbt build']) expect(dbtCommands(command).length).toBe(1)
  expect(dbtCommands('/Users/me/shows/p/.venv/bin/dbt show -s orders')[0]!.argv[0]).toBe('/Users/me/shows/p/.venv/bin/dbt')
  expect(dbtCommands('dbt run -s a && dbt test -s a').map(one => one.verb)).toEqual(['run', 'test'])
  // An export before the first invocation applies to every later one.
  expect(dbtCommands('export DBT_TARGET=prod; dbt run -s a; dbt show -s a').map(one => one.env)).toEqual([[hashedEnv('DBT_TARGET=prod')], [hashedEnv('DBT_TARGET=prod')]])
  // run-operation is its own subcommand, not a run.
  expect(dbtCommand('dbt run-operation grant_select')?.verb).toBe('run-operation')
  expect(dbtCommands('dbt deps; dbt run -s a; dbt test -s a').map(one => one.verb)).toEqual(['deps', 'run', 'test'])
  expect(dbtCommand('echo dbt is great')).toBeNull()
  // A dbt command inside another command's quoted argument is not run.
  expect(dbtCommand('altimate run "Fix the failing test, then re-run `dbt build -s orders`" --agent builder')).toBeNull()
  expect(dbtCommand(`dbt show --inline 'select 1 as "a b"' --limit 2`)?.inline).toBe('select 1 as "a b"')
  expect(projectPaths("model-paths: ['transform']\nmacro-paths:\n  # shared macros\n  - m1\n\n  - m2\nseed-paths: ['../shared']\n")).toEqual(['transform', 'snapshots', 'm1', 'm2', 'tests', 'analyses'])
  expect(projectPaths("model-paths: ['.']\n")).toContain('')
  expect(projectPaths("data-paths: ['data']\n")).toContain('data')
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
  expect(runs.find(argv => argv[1] === 'show')).toEqual([DBT, 'show', '--select', 'path:models/orders.sql,package:shop,orders', '--indirect-selection', 'empty', '--limit', '1', '--output', 'json', '--log-format', 'json'])
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

test('a dbt command that only rewrites the manifest starts no check; a change to the model\'s schema.yml checks it again', async ($, on) => {
  const { clock, runs, mtimes, setBash } = await start($, on, { show: { rows: [{ order_id: 1, order_total: 10 }] } })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'as amount', new_string: 'as order_total' })
  await clock.settle()
  const shows = () => runs.filter(argv => argv[1] === 'show').length
  expect(shows()).toBe(1)
  // Claude's own build rewrites the manifest: no warehouse query for that.
  mtimes['target/manifest.json'] = 90_000
  setBash({ stdout: `${HEADER}\nDone. PASS=11 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=11` })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  expect(shows()).toBe(1)
  // The check stays: a build says nothing about schema.yml.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /missing amount/ })).toBeDefined()
  // schema.yml (the model's patch_path) changes: the next shell command checks it again.
  mtimes['models/schema.yml'] = 95_000
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  expect(shows()).toBe(2)
  await band.unmount()
})

test('a passing run clears the failed run only when it ran what failed, in the same project', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  setBash({ stdout: `${HEADER}\nDone. PASS=2 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=2` })
  // Another model's build, and a build in another project, leave it.
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s customers' })
  await $.tool.call({ tool: 'Bash', command: 'cd /elsewhere && dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  // The same selection passing clears it.
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('a check never claims agreement it did not test: no row, no node selected', async ($, on) => {
  const show: Options['show'] = { rows: [] }
  const { clock, toasts } = await start($, on, { show })
  const first: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(first.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toContain('its columns were not compared with schema.yml: the query returned no row')
  expect(toasts).toContain('◦ orders · compiled and ran; columns not compared')
  const pane = await $.ui.mount({ ...CHECK, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'Compiles and runs; columns not compared: the query returned no row, so its columns could not be read' })).toBeDefined()
  await pane.unmount()
  // dbt exits 0 having selected nothing: that is a failure, not a pass.
  show.node = 'none'
  show.rows = [{ order_id: 1 }]
  const second: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'b', new_string: 'c' })
  await clock.settle()
  expect(second.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toContain('dbt show selected nothing for models/orders.sql (the model orders)')
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
  setBash({ stdout: `${HEADER}\nDone. PASS=11 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=11` })
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
  expect(reply.text).toBe('Running dbt show for orders; the rows open in the Query results pane.')
  expect(runs.filter(argv => argv[1] === 'show')).toEqual([[DBT, 'show', '--select', 'orders', '--indirect-selection', 'empty', '--limit', '50', '--output', 'json', '--log-format', 'json']])

  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 row · 2 columns .* · your query/ })).toBeDefined()
  await ui.press({ key: 'results-rerun' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(2)
  await ui.unmount()
})

test('the pane is titled Query results, opens wide, and Min / Default / Max resize it and are remembered', async ($, on) => {
  const { clock, sizes, store } = await start($, on, { stored: { 'pane-sizes': { 'altimate-results': 'bogus' } } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  // The default is a wide dock; a stored value that is no size is ignored.
  expect(sizes.filter(one => one.id === 'altimate-results').at(-1)).toEqual({ id: 'altimate-results', title: 'Query results', columns: 160, rows: 30 })

  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Query results$|^orders$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /● Default/ })).toBeDefined()
  await ui.press({ key: 'results-size-max' })
  await clock.settle()
  expect(sizes.at(-1)).toEqual({ id: 'altimate-results', title: 'Query results', columns: 240, rows: 60 })
  expect(await ui.find({ type: 'Button', text: /● Max/ })).toBeDefined()
  expect(store.get('pane-sizes')).toEqual({ 'altimate-results': 'max' })
  await ui.press({ key: 'results-size-min' })
  await clock.settle()
  expect(sizes.at(-1)).toEqual({ id: 'altimate-results', title: 'Query results', columns: 60, rows: 14 })
  await ui.unmount()

  // A later query opens at the size chosen, not the default.
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 60, rows: 14 })
})

test('with the terminal width known, Min, Default and Max are shares of it and differ when docked', async ($, on) => {
  const { clock, sizes } = await start($, on)
  const width = { plugin: 'altimate-code', surface: 'terminal', viewport: { columns: 200, rows: 50, isFullscreen: true } } as const
  await $.command.run({ command: 'dbt-show', args: 'orders', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.settle()
  // 35% of 200 for Default.
  expect(sizes.filter(one => one.id === 'altimate-results').at(-1)).toMatchObject({ columns: 70 })
  const ui = await $.ui.mount({ ...RESULTS, ...width })
  await ui.press({ key: 'results-size-max' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 90, rows: 60 })
  await ui.press({ key: 'results-size-min' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 50, rows: 14 })
  await ui.unmount()
})

test('a saved Max size opens the pane wide again in the next session, and a wide grid keeps long values whole', async ($, on) => {
  const { clock, sizes } = await start($, on, { stored: { 'pane-sizes': { 'altimate-results': 'max' } }, show: { rows: [{ order_id: 1, note: 'n'.repeat(70) }] } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 240, rows: 60 })
  const wide = columnWidths({ columns: ['id', 'note'], rows: [['1', 'n'.repeat(70)]] }, 120)
  expect(wide[1]).toBe(70)
  const narrow = columnWidths({ columns: ['id', 'note'], rows: [['1', 'n'.repeat(70)]] }, 30)
  expect(narrow.reduce((a, b) => a + b, 0) + 3).toBeLessThanOrEqual(30)
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

test('Re-run runs Claude\'s own dbt show again: its executable, every flag in order, its folder, its limit', async ($, on) => {
  const { clock, runs, cwds, setBash } = await start($, on)
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: `cd ${ROOT} && .venv/bin/dbt --target prod show --select orders --exclude old --limit 3 -t qa --vars '{"day": 1}' --log-format json` })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  await ui.press({ key: 'results-rerun' })
  await clock.settle()
  expect(runs.find(argv => argv[1] === '--target')).toEqual([DBT, '--target', 'prod', 'show', '--select', 'orders', '--exclude', 'old', '-t', 'qa', '--vars', '{"day": 1}', '--limit', '3', '--output', 'json', '--log-format', 'json'])
  expect(cwds.at(-1)).toBe(ROOT)
  await ui.unmount()
})

test('queries that differ only inside a string literal are two history entries; two saved at once both stay', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ a: 1 }], null) })
  await Promise.all([
    $.tool.call({ tool: 'Bash', command: `dbt show --inline "select 'a  b' as a"` }),
    $.tool.call({ tool: 'Bash', command: `dbt show --inline "select 'a b' as a"` }),
  ])
  await clock.settle()
  expect((store.get('dbt-results-history') as any[]).map(one => one.inline).sort()).toEqual(["select 'a  b' as a", "select 'a b' as a"])
})

test('history and bookmarks from an earlier session are listed, and Clear history keeps only the bookmarks', async ($, on) => {
  const saved = (title: string, bookmarked: boolean) => ({ id: JSON.stringify([ROOT, title, null, []]), title, root: ROOT, select: title, inline: null, options: [], columns: ['a'], rows: [[1]], limit: 50, ms: 1, at: 1, error: null, by: 'you', bookmarked })
  const { clock, store } = await start($, on, { stored: { 'dbt-results-history': [saved('orders', true), saved('customers', false)] } })
  await $.command.run({ command: 'dbt-show', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /★ orders/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^customers/ })).toBeDefined()
  await ui.press({ key: 'results-clear' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[]).map(one => one.title)).toEqual(['orders'])
  await ui.unmount()
})

test('a manifest over 4 MiB is read through the project\'s Python for the model Claude reads', async ($, on) => {
  const { clock, runs } = await start($, on, { manifestSize: 9 * 1024 * 1024 })
  const result: any = await $.tool.call({ tool: 'Read', file_path: ORDERS })
  await clock.settle()
  expect(runs.find(argv => argv[1] === '-c')?.slice(0, 1).concat(runs.find(argv => argv[1] === '-c')!.slice(3))).toEqual(['/proj/.venv/bin/python', '/proj/target/manifest.json', 'models/orders.sql', 'shop'])
  expect(result.context?.[0]).toContain('dbt model context for orders')
  // The slice is kept for that file and manifest revision: reading it again starts no Python.
  await $.tool.call({ tool: 'Read', file_path: ORDERS })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === '-c').length).toBe(1)
})

test('a subagent reading the model gets its context too; a /clear drops the check and the failed run', async ($, on) => {
  const { clock, setBash } = await start($, on, { show: { rows: [{ order_id: 1, order_total: 10 }] } })
  await $.tool.call({ tool: 'Read', file_path: ORDERS })
  const sub: any = await $.tool.call({ tool: 'Read', file_path: ORDERS, agentId: 'a1' })
  expect(sub.context?.[0]).toContain('dbt model context for orders')
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  await $.session.end({ reason: 'clear' } as any)
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  expect(await band.find({ key: 'dbt-check-details' })).toBeUndefined()
  await band.unmount()
})

test('the doctor fails an adapter that is not installed at all, and reads the profile from DBT_PROFILES_DIR', async ($, on) => {
  const { clock } = await start($, on, {
    version: 'Core:\n  - installed: 1.11.6\n',
    env: { DBT_PROFILES_DIR: '/proj/conf' },
    files: { 'conf/profiles.yml': 'shop:\n  target: dev\n  outputs:\n    dev:\n      type: snowflake\n' },
  })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'the profile uses snowflake, but no dbt adapter is installed beside dbt-core' })).toBeDefined()
  await ui.unmount()
})

test('the doctor reads the folders dbt_project.yml names, so a changed file under model-paths makes the manifest stale', async ($, on) => {
  const { clock } = await start($, on, {
    files: { 'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\nmodel-paths: ['transform']\n", 'transform/orders.sql': 'select 1' },
    mtimes: { 'transform/orders.sql': 5_000 },
  })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /stale: 1 file changed since it was written .* \(transform\/orders\.sql\)/ })).toBeDefined()
  await ui.unmount()
})

test('only files under model-paths are compiled and validated; a model there is, even in a custom folder', async ($, on) => {
  const { clock, runs } = await start($, on, {
    files: { 'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\nmodel-paths: ['transform']\n", 'transform/orders.sql': 'select 1', 'macros/x.sql': '' },
  })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/orders.sql`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/macros/x.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show')).toEqual([])
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/transform/orders.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(1)
})

test('a file dbt has no model for is reported as not checked, not as a failure', async ($, on) => {
  const { clock } = await start($, on, { show: { node: 'none' }, files: { 'models/disabled.sql': 'select 1' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/disabled.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('- not checked: dbt has no model for this file')
  expect(note).not.toContain('FAILED')
  expect(note).not.toContain('compiled and ran')
})

test('a dbt whose version output lists no adapters and no core version is not told to pip install one', async ($, on) => {
  const { clock } = await start($, on, { version: 'dbt-fusion 2.0.0-preview\n' })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'the profile uses duckdb; could not tell which adapters are installed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pip install dbt-duckdb/ })).toBeUndefined()
  await ui.unmount()
})

test('model-paths of "." checks a model in the project folder; a passing seed does not clear a failed run', async ($, on) => {
  const { clock, runs, setBash } = await start($, on, { files: { 'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\nmodel-paths: ['.']\n" } })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(1)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders' })
  setBash({ stdout: `${HEADER}\nDone. PASS=3 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=3` })
  await $.tool.call({ tool: 'Bash', command: 'dbt seed' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})

test('a run that excludes the failed model does not clear its failure', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders' })
  setBash({ stdout: `${HEADER}\nDone. PASS=3 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=3` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run --exclude orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})


test('checks a newer edit replaced before their turn run no query and tell Claude nothing; the newest one does', async ($, on) => {
  let release!: () => void
  const { clock, runs } = await start($, on, { holdShow: new Promise<void>(go => (release = go)) })
  // The first check's dbt show is held; two newer edits queue behind it.
  const first = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  const second = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'b', new_string: 'c' })
  const third = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'c', new_string: 'd' })
  await clock.settle()
  release()
  const results: any[] = await Promise.all([first, second, third])
  await clock.settle()
  // The first two were replaced before their turn: only the newest edit's query ran.
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(1)
  const notes = results.map(one => (one.context ?? []).filter((note: string) => note.startsWith('Altimate compile-and-validate')).length)
  expect(notes).toEqual([0, 0, 1])
})

test('a check still running at /clear tells the new conversation nothing', async ($, on) => {
  let release!: () => void
  const { clock } = await start($, on, { holdShow: new Promise<void>(go => (release = go)) })
  const edit = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  await $.session.end({ reason: 'clear' } as any)
  release()
  const result: any = await edit
  await clock.settle()
  expect((result.context ?? []).some((note: string) => note.startsWith('Altimate compile-and-validate'))).toBe(false)
})

test('a slow check\'s note goes to the agent that edited, not to a subagent\'s next tool result', async ($, on) => {
  let release!: () => void
  const { clock, setBash } = await start($, on, { holdShow: new Promise<void>(go => (release = go)) })
  const edit = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  // The edit's result goes back without the check once the hold runs out.
  await clock.advance(31_000)
  const edited: any = await edit
  expect((edited.context ?? []).some((note: string) => note.startsWith('Altimate compile-and-validate'))).toBe(false)
  release()
  await clock.settle()
  setBash({ stdout: 'ok' })
  const sub: any = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  expect((sub.context ?? []).some((note: string) => note.startsWith('Altimate compile-and-validate'))).toBe(false)
  const main: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((main.context ?? []).some((note: string) => note.startsWith('Altimate compile-and-validate'))).toBe(true)
})

test('a file changed while its check ran is checked again afterwards', async ($, on) => {
  let release!: () => void
  const { clock, runs, mtimes, setBash } = await start($, on, { holdShow: new Promise<void>(go => (release = go)), now: 1_000 })
  const edit = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  // Edited again (outside Claude) while dbt ran; the check finishes later.
  mtimes['models/orders.sql'] = 1_500
  await clock.advance(1_000)
  release()
  await edit
  await clock.settle()
  setBash({ stdout: 'ok' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(2)
})

test('an Edit of schema.yml checks the model again', async ($, on) => {
  const { clock, runs, mtimes } = await start($, on)
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  mtimes['models/schema.yml'] = 50_000
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/schema.yml`, old_string: 'amount', new_string: 'order_total' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(2)
})

test('a passing run against another target leaves a failed run as it is', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders -t prod' })
  setBash({ stdout: `${HEADER}\nDone. PASS=1 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=1` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders -t dev' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders -t prod' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('Claude\'s dbt show run with --project-dir from another folder lands in the pane', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: `cd /tmp && dbt show --project-dir ${ROOT} --select orders` })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 row · 1 columns/ })).toBeDefined()
  await ui.unmount()
})

test('Clear history is offered for a single query, and the doctor says when a folder could not be read or a file was deleted', async ($, on) => {
  const { clock, files } = await start($, on, { unreadable: ['seeds'], files: { 'seeds/raw.csv': 'a' } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ key: 'results-clear' })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const doctor = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await doctor.find({ type: 'Text', text: /not every project file could be checked/ })).toBeDefined()
  await doctor.unmount()
  // A model removed after the last parse: the manifest still lists it.
  delete files['models/revenue.sql']
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const again = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /stale: .*models\/revenue\.sql \(deleted\)/ })).toBeDefined()
  await again.unmount()
})

test('Re-run of a bare `dbt` (an activated venv, uv run) runs the project\'s own dbt, never one found on the plugin\'s PATH', async ($, on) => {
  const { clock, runs, setBash } = await start($, on)
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'source .venv/bin/activate && dbt show -s orders 2>&1 | tail -20' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  await ui.press({ key: 'results-rerun' })
  await clock.settle()
  expect(runs.find(argv => argv[1] === 'show')).toEqual([DBT, 'show', '-s', 'orders', '--limit', '5', '--output', 'json', '--log-format', 'json'])
  await ui.unmount()
})

test('a dbt show that used a shell variable is kept, but offers no Re-run', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'dbt show --target $TARGET -s orders' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ key: 'results-rerun' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Re-run is off/ })).toBeDefined()
  await ui.unmount()
})

test('a dbt run that fails after /clear puts nothing in the new conversation', async ($, on) => {
  // The conversation ends while Claude's build runs.
  const { clock, setBash } = await start($, on, { duringBash: async () => void (await $.session.end({ reason: 'clear' } as any)) })
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('a dbt show after `cd ~/x` is not filed under a guessed project', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'cd ~/elsewhere && dbt show -s orders' })
  await clock.settle()
  expect(store.get('dbt-results-history')).toBeUndefined()
})

test('a recheck waiting on its file when /clear lands runs no query and restores no check', async ($, on) => {
  const gate: Options['statGate'] = { path: 'models/orders.sql' }
  const { clock, runs, mtimes, setBash } = await start($, on, { statGate: gate })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  mtimes['models/orders.sql'] = 50_000
  let release!: () => void
  gate!.until = new Promise<void>(go => (release = go))
  setBash({ stdout: 'ok' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.session.end({ reason: 'clear' } as any)
  release()
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(1)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-check-details' })).toBeUndefined()
  await band.unmount()
})

test('runs with different DBT_TARGET in the environment do not clear each other\'s failures', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'DBT_TARGET=prod dbt run -s orders' })
  setBash({ stdout: `${HEADER}\nDone. PASS=1 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=1` })
  await $.tool.call({ tool: 'Bash', command: 'DBT_TARGET=dev dbt run -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})

test('a compile failure Claude ran with --log-format json still offers Explain and Fix', async ($, on) => {
  const { clock, prompts, setBash } = await start($, on, { runResultsAt: 1, now: 900_000 })
  setBash({ stdout: errorLog('Encountered an error:\nCompilation Error in model orders (models/orders.sql)\n  unexpected \'}\''), isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders --log-format json' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]).toContain('- model orders (models/orders.sql): Compilation Error')
  await band.unmount()
})

test('the doctor reads only the profiles.yml dbt reads: a profile missing from DBT_PROFILES_DIR is not found elsewhere', async ($, on) => {
  const { clock } = await start($, on, { env: { DBT_PROFILES_DIR: '/proj/conf' }, files: { 'conf/profiles.yml': 'other:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n' } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /no profile found for this project/ })).toBeDefined()
  await ui.unmount()
})

test('a project folder spelled `.` or `..` is one project: one history entry, filed under its plain path', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: `cd ${ROOT}/./models/.. && dbt show -s orders` })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[])[0].root).toBe(ROOT)
})

test('a project whose target-path is not `target` gets model context from its own artifact folder', async ($, on) => {
  const { clock } = await start($, on, { target: 'build', files: { 'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\ntarget-path: build\n" } })
  const result: any = await $.tool.call({ tool: 'Read', file_path: ORDERS })
  await clock.settle()
  expect(result.context?.[0]).toContain('dbt model context for orders')
})

test('an edit of schema.yml checks the model again even when the model had no schema file before', async ($, on) => {
  const manifest = JSON.parse(JSON.stringify(MANIFEST))
  delete manifest.nodes['model.shop.orders'].patch_path
  const { clock, runs } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(manifest) } })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/models/schema.yml`, content: 'version: 2' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(2)
})

test('the doctor does not call a package\'s model deleted, and a manifest over 4 MiB is not a "may be stale"', async ($, on) => {
  const manifest = JSON.parse(JSON.stringify(MANIFEST))
  manifest.metadata = { project_name: 'shop' }
  for (const node of Object.values<any>(manifest.nodes)) node.package_name = 'shop'
  manifest.nodes['model.elementary.edr_runs'] = { name: 'edr_runs', resource_type: 'model', package_name: 'elementary', original_file_path: 'models/edr/edr_runs.sql', depends_on: { nodes: [] } }
  const { clock } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(manifest) } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^current \(written/ })).toBeDefined()
  await ui.unmount()
})

test('a manifest over 4 MiB leaves the freshness check to the changed files', async ($, on) => {
  const { clock } = await start($, on, { manifestSize: 9 * 1024 * 1024 })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^current \(written/ })).toBeDefined()
  await ui.unmount()
})

test('an edit of a .yml outside the checked model\'s project, or in its build output, starts no query', async ($, on) => {
  const { clock, runs } = await start($, on)
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  await $.tool.call({ tool: 'Edit', file_path: '/elsewhere/.github/workflows/ci.yml', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/target/run_results.yml`, content: 'x' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(1)
})

test('a file path with `..` in it is read as the plain path inside its project', async ($, on) => {
  const { clock, runs } = await start($, on)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/../models/orders.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.find(argv => argv[1] === 'show')?.[3]).toBe('path:models/orders.sql,package:shop,orders')
})

test('a schema.yml written while the model\'s first check still runs checks it again once that check ends', async ($, on) => {
  let release!: () => void
  const { clock, runs } = await start($, on, { holdShow: new Promise<void>(go => (release = go)) })
  const edit = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  await clock.advance(31_000)
  await edit
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/models/schema.yml`, content: 'version: 2' })
  release()
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(2)
})

test('a relative DBT_PROFILES_DIR is read from the project folder', async ($, on) => {
  const { clock } = await start($, on, { env: { DBT_PROFILES_DIR: 'conf' }, files: { 'conf/profiles.yml': 'shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n' } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^duckdb 1\.10\.1$/ })).toBeDefined()
  await ui.unmount()
})

test('a deleted schema file makes its check run again, and the doctor finds a deleted macro or schema file', async ($, on) => {
  const { clock, runs, files, setBash } = await start($, on, { files: { 'macros/cents.sql': '' } })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  delete files['models/schema.yml']
  setBash({ stdout: 'ok' })
  await $.tool.call({ tool: 'Bash', command: 'rm models/schema.yml' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(2)
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /models\/schema\.yml \(deleted\)/ })).toBeDefined()
  await ui.unmount()
})

test('history entries tell environment names apart, not their values (a value is never persisted)', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'DBT_TARGET=prod dbt show -s orders' })
  await $.tool.call({ tool: 'Bash', command: 'DBT_TARGET=dev dbt show -s orders' })
  await $.tool.call({ tool: 'Bash', command: 'DBT_SCHEMA=dev dbt show -s orders' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[]).length).toBe(2)
})

test('an unrelated edit while a check runs does not replace a pending recheck', async ($, on) => {
  let release!: () => void
  const { clock, runs } = await start($, on, { holdShow: new Promise<void>(go => (release = go)), files: { 'macros/cents.sql': '' } })
  const edit = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  await clock.advance(31_000)
  await edit
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/macros/cents.sql`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/elsewhere/.github/workflows/ci.yml', old_string: 'a', new_string: 'b' })
  release()
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(2)
})

test('Claude\'s plain `dbt show` (dbt\'s text table, as dbt prints it) lands in the pane', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: "\u001b[0m06:36:55  Running with dbt=1.11.6\n\u001b[0m06:36:55  Previewing node 'customers':\n| customer_id | first_name |\n| ----------- | ---------- |\n|           1 | Michael    |\n|           2 | Shawn      |\n" })
  await $.tool.call({ tool: 'Bash', command: '.venv/bin/dbt show -s customers --limit 2' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /2 rows · 2 columns/ })).toBeDefined()
  await ui.unmount()
})

test('compound dbt commands: a run then a test is one compound result, and different shows in one command save no rows', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders && dbt test -s orders' })
  setBash({ stdout: `${HEADER}\nDone. PASS=1 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=1` })
  // A passing run alone did not rerun the failing test: the failure stays.
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
  setBash({ stdout: showLog([{ customer_id: 1 }], 'customers') })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders; dbt show -s customers' })
  await clock.settle()
  // Different shows in one command: which rows are whose cannot be told, so none are saved.
  expect((store.get('dbt-results-history') as any[] | undefined) ?? []).toEqual([])
})

test('a dbt command run where Claude\'s shell is (a subfolder project after a cd) is found there', async ($, on) => {
  // The session starts above the project; Claude's shell has moved into it.
  const { clock, setBash } = await start($, on, { sessionRoot: '/', cwd: ROOT })
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})

test('validation previews only the edited model when dbt shows several', async ($, on) => {
  const two = [showLog([{ order_id: 1, amount: 2 }], 'orders'), JSON.stringify({ data: { node_name: 'orders', output_format: 'json', preview: JSON.stringify([{ other: 1 }]), unique_id: 'model.pkg.orders' }, info: { code: 'Q041' } })].join('\n')
  expect(showPreview(two, 'model.shop.orders')?.columns).toEqual(['order_id', 'amount'])
  const { clock } = await start($, on, { show: { rows: [{ order_id: 1, amount: 2 }] } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toContain('the warehouse returned 2 columns')
})

test('the doctor finds packages installed under packages-install-path', async ($, on) => {
  const { clock } = await start($, on, { files: { 'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\npackages-install-path: vendor\n", 'packages.yml': 'packages: []', 'vendor/dbt_utils/dbt_project.yml': 'name: dbt_utils' } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'vendor installed' })).toBeDefined()
  await ui.unmount()
})

test('a compound run with the same target on each part is cleared by a whole-project build on that target', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -t prod -s orders && dbt test -t prod -s orders' })
  setBash({ stdout: `${HEADER}\nDone. PASS=11 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=11` })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -t prod' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

// ─── Failure recording, show attribution, check ordering, manifest slice ─────────────────────────

const RUN_PASSED = 'Done. PASS=3 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=3'
const TEST_FAILED = BUILD_FAILED.replace('PASS=10 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=11', 'PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1')

kitTest('output with several summaries has failed when any of them has errors', () => {
  expect(saysFailed(`${RUN_PASSED}\n${TEST_FAILED}`)).toBe(true)
  expect(saysFailed(`${TEST_FAILED}\n${RUN_PASSED}`)).toBe(true)
  expect(saysFailed(`${RUN_PASSED}\n${RUN_PASSED}`)).toBe(false)
})

test('a passing run followed by a failing test in one command still posts the failure band', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: `${RUN_PASSED}\n${TEST_FAILED}\nfinished` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders; dbt test -s orders; echo finished' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})

test('a /clear while the shell folder is being read does not let the failed run back in', async ($, on) => {
  let release!: () => void
  const { clock, setBash } = await start($, on, { holdCwd: new Promise<void>(go => (release = go)) })
  setBash({ stdout: BUILD_FAILED, isError: true })
  const call = $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  await $.session.end({ reason: 'clear' } as any)
  release()
  await call
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('different shows in one command save nothing, named node or not; one show is saved', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  const table = (head: string, cell: string) => `06:36:55  Previewing node '${head}':\n| id |\n| -- |\n| ${cell} |\n`
  setBash({ stdout: `${table('orders', 'o1')}${table('customers', 'c1')}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders && dbt show -s customers' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[] | undefined) ?? []).toEqual([])
  // With JSON logs that name each node it is the same: nothing is saved.
  setBash({ stdout: `${showLog([{ id: 'o1' }], 'orders')}\n${showLog([{ id: 'c1' }], 'customers')}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders && dbt show -s customers' })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders -t prod || dbt show -s path:models/orders.sql -t dev' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[] | undefined) ?? []).toEqual([])
  // One show with plain text is still saved.
  setBash({ stdout: table('orders', 'o1') })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[]).map(one => one.select)).toContain('orders')
})

kitTest('the manifest slice bounds the direct tests by the same node cap as the graph walk', () => {
  // Python cannot run in a hooks test: the script is read for its bound on the tests it adds.
  expect(MANIFEST_SLICE).not.toContain('keep.update(tests)')
  expect(MANIFEST_SLICE).toMatch(/for t in tests:\n\s+if len\(keep\) >= 20000:\n\s+break\n\s+keep\.add\(t\)/)
  // The tests go in before the walk, so the cap on the walk never drops them.
  expect(MANIFEST_SLICE.indexOf('keep.add(t)')).toBeLessThan(MANIFEST_SLICE.indexOf('for graph in (pm, cm)'))
})

test('a failing dbt retry posts the failure band; a passing retry never clears it', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt retry' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  // Output with a header per invocation proves the retry passed; it still clears nothing.
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt retry' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  // Nor does it clear the failure of another run.
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt retry' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  // A compound with a retry fails and passes as one command: passing again does not clear it either.
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders && dbt retry' })
  await clock.settle()
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}\n${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders && dbt retry' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})

test('an older check of one file landing after a newer check of another file does not open its pane or toast; the newest lands in the band', async ($, on) => {
  let release!: () => void
  const { clock, opened, toasts } = await start($, on, { holdShow: new Promise<void>(go => (release = go)), show: { rows: [{ order_id: 1, order_total: 10 }] } })
  // orders.sql drifts from schema.yml (a pane opens for it); revenue.sql documents no columns (it does not).
  const first = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  const second = $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/revenue.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  release()
  await Promise.all([first, second])
  await clock.settle()
  expect(opened.filter(one => one.startsWith('altimate-check'))).toEqual([])
  expect(toasts.filter(one => /orders ·/.test(one))).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /revenue/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^(✓|✖|⚠|◦) orders/ })).toBeUndefined()
  await band.unmount()
})

test('an edit from a conversation that ended while it waited does not keep the next conversation\'s check from landing', async ($, on) => {
  let release!: () => void
  let releaseShow!: () => void
  const { clock } = await start($, on, { show: { rows: [{ order_id: 1, order_total: 10 }] }, holdEdit: new Promise<void>(go => (release = go)), holdShow: new Promise<void>(go => (releaseShow = go)) })
  const old = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  await $.session.end({ reason: 'clear' } as any)
  // The new conversation's check is running (its dbt show is held) when the old edit resumes.
  const fresh = $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/revenue.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  release()
  await clock.settle()
  releaseShow()
  await Promise.all([old, fresh])
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /revenue/ })).toBeDefined()
  // The finished check shows its Details button; a check left running has none.
  expect(await band.find({ key: 'dbt-check-details' })).toBeDefined()
  await band.unmount()
})

test('a passing run summary does not hide a compilation error from a later command', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}\n${HEADER}\n06:45:43  Encountered an error:\nCompilation Error\n  Model 'model.shop.orders' depends on a node named 'x' which was not found\nfinished` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders; dbt test -s orders; echo finished' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})

test('the same plain-text preview run twice is attributed to that show', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: "06:36:55  Previewing node 'orders':\n| id |\n| -- |\n| o1 |\n" })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders || dbt show -s orders' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[]).map(one => [one.select, one.rows])).toEqual([['orders', [['o1']]]])
})

const HEADER = '06:45:40  Running with dbt=1.11.6'
const COMPILE_ERROR = "06:45:43  Encountered an error:\nCompilation Error\n  Model 'broken' depends on a node named 'x' which was not found"
const PASSED_AFTER_ERROR = `06:45:43  Encountered an error:\nCompilation Error\n  Model 'broken' depends on a node named 'x' which was not found\n${RUN_PASSED}`

kitTest('an invocation is judged from its own piece of output: a later passing summary does not hide its error, an earlier error does not fail a later pass', () => {
  // Without headers the order cannot be trusted: an error anywhere is a failure.
  expect(saysFailed(PASSED_AFTER_ERROR)).toBe(true)
  // With one piece of output per invocation, an error after a passing run's summary is the next one's.
  expect(saysFailed(`${HEADER}\n${RUN_PASSED}\n${HEADER}\nCompilation Error\n  broken`, ['run', 'test'])).toBe(true)
})

test('a passing run after an earlier error, each with its own header, posts no band and clears a matching failure', async ($, on) => {
  const { clock, setBash } = await start($, on)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  setBash({ stdout: `${HEADER}\n${COMPILE_ERROR}\n${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt compile -s broken; dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('output that does not split per invocation never clears a failure, and an error anywhere in it is one', async ($, on) => {
  const { clock, setBash } = await start($, on)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  // An error with no header before a later passing header, a passing summary then a kill: nothing is cleared.
  for (const stdout of [`${COMPILE_ERROR}\n${HEADER}\n${RUN_PASSED}`, `${RUN_PASSED}\nKilled: 9`, `${HEADER}\n${RUN_PASSED}`]) {
    setBash({ stdout })
    await $.tool.call({ tool: 'Bash', command: stdout.startsWith('Done') ? 'dbt build -s orders' : 'dbt compile -s b; dbt build -s orders' })
    await clock.settle()
    expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  }
  await band.unmount()
})

test('a header-less compile error after a passing summary is a failure', async ($, on) => {
  const { clock, setBash } = await start($, on)
  setBash({ stdout: `${RUN_PASSED}\n${COMPILE_ERROR}\nfinished` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders; dbt --quiet test -s orders; echo finished' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})

kitTest('a subcommand named in an argument of another command is not a dbt invocation', () => {
  expect(dbtCommands('git diff -- dbt docs/')).toEqual([])
  expect(dbtCommands('git diff -- dbt docs/ && dbt run -s a').map(one => one.verb)).toEqual(['run'])
  expect(dbtCommands('uv run dbt deps; DBT_X=1 dbt docs generate').map(one => one.verb)).toEqual(['deps', 'docs'])
})

test('shows that differ only in a flag such as --limit are not attributed', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: "06:36:55  Previewing node 'orders':\n| id |\n| -- |\n| o1 |\n" })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders --limit 1 || dbt show -s orders --limit 2' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[] | undefined) ?? []).toEqual([])
})

test('a recheck that waited on a file while a newer check of another file ran does not take the band back', async ($, on) => {
  const gate: Options['statGate'] = { path: 'models/orders.sql' }
  const { clock, mtimes, setBash } = await start($, on, { statGate: gate })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  mtimes['models/orders.sql'] = 50_000
  let release!: () => void
  gate!.until = new Promise<void>(go => (release = go))
  setBash({ stdout: 'ok' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  // Another model's check starts and finishes while the recheck waits on its stat.
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/revenue.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  release()
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /revenue/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /match schema\.yml/ })).toBeUndefined()
  await band.unmount()
})

test('a recheck that lands after a newer check started says nothing about the band', async ($, on) => {
  let release!: () => void
  const { clock, mtimes, toasts, setBash } = await start($, on, { holdShow: new Promise<void>(go => (release = go)), holdShowAfter: 1 })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  mtimes['models/orders.sql'] = 50_000
  setBash({ stdout: 'ok' })
  // The recheck's dbt show is held; another model's edit starts its check behind it.
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  const second = $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/revenue.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  release()
  await second
  await clock.settle()
  expect(toasts.filter(one => one.includes('checked again'))).toEqual([])
})

const jsonLine = (msg: string) => JSON.stringify({ info: { code: 'Z', level: 'info', msg } })

kitTest('a run that failed before writing a summary fails the command even when a later run passes', () => {
  const output = `${HEADER}\n${COMPILE_ERROR}\n${HEADER}\n${RUN_PASSED}`
  expect(saysFailed(output, ['run', 'run'])).toBe(true)
})

kitTest('plain and JSON log lines keep the order they were printed in', () => {
  // A plain passing summary, then a JSON-logged compilation error from the next invocation.
  const output = [HEADER, RUN_PASSED, jsonLine(HEADER), jsonLine('Encountered an error:\nCompilation Error\n  broken')].join('\n')
  expect(saysFailed(output, ['run', 'test'])).toBe(true)
  // The JSON error first, then a plain passing run: the error belongs to the first invocation.
  expect(saysFailed([jsonLine(HEADER), jsonLine('Compilation Error\n  broken'), HEADER, RUN_PASSED].join('\n'), ['run', 'run'])).toBe(true)
})

kitTest('a failed compile, show or parse does not make a run failed', () => {
  expect(saysFailed(`${HEADER}\n${RUN_PASSED}\n${HEADER}\n${COMPILE_ERROR}`, ['run', 'compile'])).toBe(false)
})

kitTest('when the output does not split per invocation, a summary with errors, or error text with no summary, fails', () => {
  // `dbt run -s a || dbt run -s b`: only the first ran.
  expect(saysFailed(`${HEADER}\n${RUN_PASSED}`, ['run', 'run'])).toBe(false)
  expect(saysFailed(`${HEADER}\n${COMPILE_ERROR}`, ['run', 'run'])).toBe(true)
  expect(saysFailed(`${HEADER}\n${BUILD_FAILED}`, ['build', 'build'])).toBe(true)
  expect(saysFailed(PASSED_AFTER_ERROR)).toBe(true)
  expect(dbtVerdict(PASSED_AFTER_ERROR, ['compile', 'run'])).toEqual({ failed: true, passed: false, mapped: false })
})

test('a failed run followed by a passing one in one command posts the band; a failed compile after a passing run does not', async ($, on) => {
  const { clock, setBash } = await start($, on)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  setBash({ stdout: `${HEADER}\n${COMPILE_ERROR}\n${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s broken; dbt run -s ok' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  setBash({ stdout: `${HEADER}\n${COMPILE_ERROR}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s broken' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  // The compile that failed after a passing run is not the run's failure: it clears the matching one.
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}\n${HEADER}\n${COMPILE_ERROR}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s broken; dbt compile -s b | tail' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

kitTest('when the headers do not match the invocations, any failed piece fails the command, whatever its verb', () => {
  // `dbt run -s broken && dbt test -s broken; dbt run -s ok`: the first failed, so the test never ran.
  expect(saysFailed(`${HEADER}\n${COMPILE_ERROR}\n${HEADER}\n${RUN_PASSED}`, ['run', 'test', 'run'])).toBe(true)
  // `dbt deps; dbt run -s a; dbt test -s a`: three headers, and the failing piece is the last.
  expect(saysFailed(`${HEADER}\nInstalled\n${HEADER}\n${RUN_PASSED}\n${HEADER}\n${TEST_FAILED}`, ['run', 'test'])).toBe(true)
  expect(saysFailed(`${HEADER}\nInstalled\n${HEADER}\n${RUN_PASSED}\n${HEADER}\n${RUN_PASSED}`, ['run', 'test'])).toBe(false)
})

test('a run followed by a compile that sets the exit code is not a failed run; a compile error before a passing run is', async ($, on) => {
  const { clock, setBash } = await start($, on)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}\n${HEADER}\n${COMPILE_ERROR}`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders; dbt compile -s broken' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  setBash({ stdout: `${HEADER}\n${COMPILE_ERROR}\n${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s broken && dbt test -s broken; dbt run -s ok; echo finished' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})

test('a preview naming a node that no show selects is not given to the last of several different shows', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ id: 'o1' }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s path:models/orders.sql && dbt show -s customers' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[] | undefined) ?? []).toEqual([])
  // A single show keeps its rows, whatever name dbt gives the node.
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s path:models/orders.sql' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[]).map(one => one.select)).toEqual(['path:models/orders.sql'])
})

test('a run killed before its summary is a failure when the shell says so, and never clears one', async ($, on) => {
  const { clock, setBash } = await start($, on)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Killed, and the shell reports it: a failure (the band reads the run's own results).
  setBash({ stdout: `${HEADER}\nKilled: 9`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  // Killed, and the shell says nothing: not a failure, and the failure that is there stays.
  setBash({ stdout: `${HEADER}\nKilled: 9` })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  // A run that shows its passing summary clears it.
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

kitTest('a piece with no summary and no error text proves nothing; a passing summary does', () => {
  expect(dbtVerdict(`${HEADER}\nKilled: 9`, ['run'])).toEqual({ failed: false, passed: false, mapped: true })
  expect(dbtVerdict(`${HEADER}\n${RUN_PASSED}\n${HEADER}\nKilled: 9`, ['run', 'test'])).toEqual({ failed: false, passed: false, mapped: true })
  expect(dbtVerdict(`${HEADER}\n${RUN_PASSED}`, ['run'])).toEqual({ failed: false, passed: true, mapped: true })
  expect(dbtVerdict('Killed: 9', [])).toEqual({ failed: false, passed: false, mapped: false })
})

test('shows of one selection that differ in target are not attributed, even when the preview names the node', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ id: 'prod' }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders -t prod --limit 1 || dbt show -s orders -t dev --limit 50' })
  await clock.settle()
  expect((store.get('dbt-results-history') as any[] | undefined) ?? []).toEqual([])
})

kitTest('a `dbt` at a line end and `source` on the next line are not a dbt subcommand', () => {
  expect(dbtCommands('cd dbt\nsource .venv/bin/activate')).toEqual([])
  expect(dbtCommands('cd dbt\nsource .venv/bin/activate && dbt show -s a').map(one => one.verb)).toEqual(['show'])
})

// ─── Versioned models, doctor freshness, flags before the verb, profile comments, dependencies.yml ──

test('a versioned model whose file has another name is selected by its name too, and previewed', async ($, on) => {
  const manifest = { metadata: { project_name: 'shop' }, parent_map: {}, child_map: {}, nodes: { 'model.shop.orders': { name: 'orders', resource_type: 'model', package_name: 'shop', version: 1, original_file_path: 'models/legacy.sql', config: {}, columns: {}, depends_on: { nodes: [] } } } }
  const { clock, runs, toasts } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(manifest), 'models/legacy.sql': 'select 1' }, show: { rows: [{ order_id: 1 }], node: 'orders', mustInclude: 'orders' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/legacy.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.find(argv => argv[1] === 'show')?.[3]).toBe('path:models/legacy.sql,package:shop,orders')
  expect(toasts.some(one => one.startsWith('✖'))).toBe(false)
  expect((result.context ?? []).some((note: string) => note.includes('FAILED'))).toBe(false)
})

test('a model file the manifest does not list, added to a folder that changed since the manifest, makes it stale whatever its own timestamp', async ($, on) => {
  const { clock } = await start($, on, { files: { 'models/copied.sql': 'select 1' }, mtimes: { 'models/copied.sql': 100, models: 2_000 } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /stale: 1 file changed since it was written .* \(models\/copied\.sql\)/ })).toBeDefined()
  await ui.unmount()
})

kitTest('a flag before the verb never takes a subcommand word as its value', () => {
  expect(dbtCommand('dbt --debug run --target test')?.verb).toBe('run')
  expect(dbtCommand('dbt --debug show --target test')?.verb).toBe('show')
  expect(dbtCommand('dbt --target=test run')?.verb).toBe('run')
  expect(dbtCommand('dbt --target prod run')?.verb).toBe('run')
  expect(dbtCommand('dbt --target test run')?.verb).toBe('run')
  expect(dbtCommand('dbt -t prod --debug show -s x')?.verb).toBe('show')
  expect(dbtCommand('dbt --unknown-flag run')?.verb).toBe('run')
})

test('a profile name followed by a YAML comment is found', async ($, on) => {
  const { clock } = await start($, on, { profiles: 'shop:  # dev\n  target: prod\n  outputs:\n    prod:\n      type: snowflake\n' })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'the profile uses snowflake, but only duckdb is installed' })).toBeDefined()
  await ui.unmount()
})

test('a dependencies.yml with only projects has no packages to install; one with packages is named in the check', async ($, on) => {
  const { clock } = await start($, on, { files: { 'dependencies.yml': 'projects:\n  - name: other\n' } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /is not installed/ })).toBeUndefined()
  await ui.unmount()
})

test('a dependencies.yml that declares packages is named when they are not installed', async ($, on) => {
  const { clock } = await start($, on, { files: { 'dependencies.yml': 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n' } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /dependencies\.yml is not installed/ })).toBeDefined()
  await ui.unmount()
})

// ─── Doctor inventory, versioned model retry, profile output spellings ───────────────────────────

const shopManifest = () => {
  const manifest = JSON.parse(JSON.stringify(MANIFEST))
  manifest.metadata = { project_name: 'shop' }
  for (const node of Object.values<any>(manifest.nodes)) node.package_name = 'shop'
  return manifest
}

async function doctorIsCurrent($: any, clock: any) {
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  const current = await ui.find({ type: 'Text', text: /^current \(written/ })
  await ui.unmount()
  return !!current
}

test('YAML documenting a macro, and a macro file, do not make the manifest stale', async ($, on) => {
  const manifest = shopManifest()
  manifest.macros = { 'macro.shop.m': { name: 'm', package_name: 'shop', original_file_path: 'macros/m.sql', patch_path: 'shop://macros/schema.yml' } }
  const { clock } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(manifest), 'macros/m.sql': '{% macro m() %}{% endmacro %}', 'macros/schema.yml': 'macros:\n  - name: m\n' }, mtimes: { macros: 2_000 } })
  expect(await doctorIsCurrent($, clock)).toBe(true)
})

test('YAML documenting a disabled model does not make the manifest stale', async ($, on) => {
  const manifest = shopManifest()
  manifest.disabled = { 'model.shop.off': [{ name: 'off', resource_type: 'model', package_name: 'shop', original_file_path: 'models/off.sql', patch_path: 'shop://models/off.yml' }] }
  const { clock } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(manifest), 'models/off.sql': 'select 1', 'models/off.yml': 'models:\n  - name: off\n' }, mtimes: { models: 2_000 } })
  expect(await doctorIsCurrent($, clock)).toBe(true)
})

test('with model-paths of ".", the project\'s root config files are not unknown files', async ($, on) => {
  const { clock } = await start($, on, { files: { 'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\nmodel-paths: ['.']\n", 'packages.yml': 'packages: []', 'selectors.yml': 'selectors: []', 'package-lock.yml': 'packages: []' }, mtimes: { 'packages.yml': 100, 'selectors.yml': 100, 'package-lock.yml': 100, 'dbt_project.yml': 100, 'profiles.yml': 100 } })
  expect(await doctorIsCurrent($, clock)).toBe(true)
})

test('an unlisted file with an old timestamp in a folder that is older than the manifest is current after a parse', async ($, on) => {
  const { clock } = await start($, on, { files: { 'models/copied.sql': 'select 1' }, mtimes: { 'models/copied.sql': 100, models: 900 } })
  expect(await doctorIsCurrent($, clock)).toBe(true)
})

test('a versioned model\'s first check, with no manifest yet, asks again with the name the new manifest gives it', async ($, on) => {
  const manifest = { metadata: { project_name: 'shop' }, parent_map: {}, child_map: {}, nodes: { 'model.shop.orders': { name: 'orders', resource_type: 'model', package_name: 'shop', version: 1, original_file_path: 'models/legacy.sql', config: {}, columns: {}, depends_on: { nodes: [] } } } }
  const { clock, runs, toasts } = await start($, on, { manifestAfterShow: manifest, files: { 'models/legacy.sql': 'select 1' }, show: { rows: [{ order_id: 1 }], node: 'orders', mustInclude: 'orders' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/legacy.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').map(argv => argv[3])).toEqual(['path:models/legacy.sql,package:shop', 'path:models/legacy.sql,package:shop,orders'])
  expect(toasts.some(one => one.startsWith('✖'))).toBe(false)
  expect((result.context ?? []).some((note: string) => note.includes('FAILED'))).toBe(false)
})

test('a check whose manifest holds an old name for the model asks again with the name dbt now has', async ($, on) => {
  const node = (name: string) => ({ name, resource_type: 'model', package_name: 'shop', version: 1, original_file_path: 'models/legacy.sql', config: {}, columns: {}, depends_on: { nodes: [] } })
  const manifest = (name: string) => ({ metadata: { project_name: 'shop' }, parent_map: {}, child_map: {}, nodes: { 'model.shop.orders': node(name) } })
  const { clock, runs, toasts } = await start($, on, { manifestAfterShow: manifest('orders'), files: { 'target/manifest.json': JSON.stringify(manifest('legacy_name')), 'models/legacy.sql': 'select 1' }, show: { rows: [{ order_id: 1 }], node: 'orders', mustInclude: 'orders' } })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/legacy.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').map(argv => argv[3])).toEqual(['path:models/legacy.sql,package:shop,legacy_name', 'path:models/legacy.sql,package:shop,orders'])
  expect(toasts.some(one => one.startsWith('✖'))).toBe(false)
})

for (const [name, output] of [['a trailing comment', "    prod:   # production\n      type: snowflake\n"], ['quotes', "    'prod':\n      type: snowflake\n"], ['flow style', '    "prod": {type: snowflake, account: x}\n']] as const) {
  test(`a profile's target output is found with ${name}`, async ($, on) => {
    const { clock } = await start($, on, { profiles: `shop:\n  target: prod\n  outputs:\n    dev:\n      type: duckdb\n${output}` })
    await $.command.run({ command: 'dbt-doctor', args: '' })
    await clock.settle()
    const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'the profile uses snowflake, but only duckdb is installed' })).toBeDefined()
    await ui.unmount()
  })
}

// ─── Failures from the artifact and the text, the full command, deps ─────────────────────────────

test('two failing invocations in one command both reach the band, whichever one wrote run_results.json', async ($, on) => {
  const results = { results: [{ unique_id: 'test.shop.not_null_customers_id.abc', status: 'error', message: 'Runtime Error in test not_null_customers_id (models/schema.yml)\n  boom' }] }
  const { clock, setBash } = await start($, on, { files: { 'target/run_results.json': JSON.stringify(results) } })
  setBash({ stdout: `${HEADER}\n06:45:43  Compilation Error in model orders (models/orders.sql)\n  unexpected '}'\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1\n${HEADER}\n${TEST_FAILED.replace('not_null_orders_amount', 'not_null_customers_id')}`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders; dbt test -s customers' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'not_null_customers_id, orders' })).toBeDefined()
  await band.unmount()
})

test('a run_results.json written just before the command started is not this command\'s', async ($, on) => {
  const { clock, setBash } = await start($, on, { runResultsAt: 500, now: 1_000 })
  setBash({ stdout: '\u001b[0m06:45:43  Compilation Error in model customers (models/customers.sql)\n  boom\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1', isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s customers' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'customers' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /not_null_orders_amount/ })).toBeUndefined()
  await band.unmount()
})

test('a long command is kept whole for Explain and Fix; the band shows no more than the failure', async ($, on) => {
  const { clock, prompts, setBash } = await start($, on)
  const command = `dbt build -s orders --vars '${JSON.stringify({ note: 'x'.repeat(650) })}'`
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: new RegExp('x{300}') })).toBeUndefined()
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]).toContain(`\`${command}\``)
  await band.unmount()
})

test('a versioned model whose retry also shows nothing ends FAILED, naming the model dbt now has', async ($, on) => {
  const manifest = { metadata: { project_name: 'shop' }, parent_map: {}, child_map: {}, nodes: { 'model.shop.orders': { name: 'orders', resource_type: 'model', package_name: 'shop', version: 1, original_file_path: 'models/legacy.sql', config: {}, columns: {}, depends_on: { nodes: [] } } } }
  const { clock, runs } = await start($, on, { manifestAfterShow: manifest, files: { 'models/legacy.sql': 'select 1' }, show: { rows: [{ order_id: 1 }], node: 'orders', mustInclude: 'never_selected' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/legacy.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show').length).toBe(2)
  const note = (result.context ?? []).join('\n')
  expect(note).toContain('FAILED')
  expect(note).toContain('the model orders')
})

test('Run dbt deps that fails says so and does not go on to parse', async ($, on) => {
  const { clock, runs, toasts } = await start($, on, { interactive: true, files: { 'packages.yml': 'packages: []' }, depsFails: 'Could not find a version of dbt_utils' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-doctor-deps' })
  await clock.settle()
  expect(runs.some(argv => argv[1] === 'deps')).toBe(true)
  expect(toasts.some(one => one.startsWith('✖ dbt deps failed · Could not find a version of dbt_utils'))).toBe(true)
  expect(runs.some(argv => argv[1] === 'parse')).toBe(false)
  await band.unmount()
})

// ─── What a passing run must have in common with the failed one ──────────────────────────────────

const failedBuild = async ($: any, on: any, command: string) => {
  const ctx = await start($, on)
  ctx.setBash({ stdout: `${HEADER}\n${BUILD_FAILED}`, isError: true })
  await $.tool.call({ tool: 'Bash', command })
  await ctx.clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  return { ...ctx, band }
}

test('a passing run that does less or other work than the failed one leaves the failure', async ($, on) => {
  const { clock, setBash, band } = await failedBuild($, on, 'dbt build -s orders')
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  for (const extra of ['--exclude-resource-types test', '--resource-type model', '--indirect-selection empty', '--empty', '--full-refresh']) {
    await $.tool.call({ tool: 'Bash', command: `dbt build -s orders ${extra}` })
    await clock.settle()
    expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  }
  await band.unmount()
})

test('a failed full-refresh run is not cleared by a normal run, but a repeat of it is', async ($, on) => {
  const { clock, setBash, band } = await failedBuild($, on, 'dbt run -s orders --full-refresh')
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders --full-refresh' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('a passing run that differs only in display flags clears the failure', async ($, on) => {
  const { clock, setBash, band } = await failedBuild($, on, 'dbt build -s orders')
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders --log-format json --threads 8 -q' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

kitTest('a command\'s identity is every flag but the selection and display-only ones', () => {
  expect(dbtCommand('dbt build -s orders --log-format json --threads 8')?.identity).toEqual([])
  expect(dbtCommand('dbt --warn-error -t prod build --select orders --full-refresh --vars \'{"a": 1}\'')?.identity).toEqual(['--full-refresh', '--target prod', '--vars {"a": 1}', '--warn-error'])
  // History and replay keep reading the context flags alone.
  expect(dbtCommand('dbt build -s orders --full-refresh -t prod')?.options).toEqual(['--target', 'prod'])
})

test('a changed doc block file makes the manifest stale, and so does a deleted one the manifest lists', async ($, on) => {
  const manifest = shopManifest()
  manifest.docs = { 'doc.shop.d': { name: 'd', package_name: 'shop', original_file_path: 'docs/descriptions.md' } }
  const { clock } = await start($, on, { files: { 'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\ndocs-paths: ['docs']\n", 'target/manifest.json': JSON.stringify(manifest), 'docs/descriptions.md': '{% docs d %}x{% enddocs %}' }, mtimes: { 'docs/descriptions.md': 5_000 } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /stale: 1 file changed since it was written .* \(docs\/descriptions\.md\)/ })).toBeDefined()
  await ui.unmount()
})

test('a doc block file the manifest lists that is gone makes it stale', async ($, on) => {
  const manifest = shopManifest()
  manifest.docs = { 'doc.shop.d': { name: 'd', package_name: 'shop', original_file_path: 'docs/descriptions.md' } }
  const { clock } = await start($, on, { files: { 'dbt_project.yml': "name: 'shop'\nprofile: 'shop'\ndocs-paths: ['docs']\n", 'target/manifest.json': JSON.stringify(manifest) } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /docs\/descriptions\.md \(deleted\)/ })).toBeDefined()
  await ui.unmount()
})

kitTest('a versioned model in a large manifest is named without its version', () => {
  const results = { results: [{ unique_id: 'model.shop.dim.v2', status: 'error', message: 'boom' }, { unique_id: 'model.shop.plain', status: 'error', message: 'boom' }] }
  expect(failuresFrom(results, null).map(one => one.name)).toEqual(['dim', 'plain'])
})

test('the last --target wins: a passing run with the targets in the other order leaves the failure', async ($, on) => {
  const { clock, setBash, band } = await failedBuild($, on, 'dbt build -s orders --target dev --target prod')
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders --target prod --target dev' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.unmount()
})

test('flags that moved between the invocations of a compound command are not the same command', async ($, on) => {
  const { clock, setBash, band } = await failedBuild($, on, 'dbt run -s orders --full-refresh; dbt test -s orders --target prod')
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}\n${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders --full-refresh --target prod; dbt test -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  // The same command again clears it.
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders --full-refresh; dbt test -s orders --target prod' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

kitTest('a model is named by the third part of its id, whatever follows', () => {
  const results = { results: ['model.shop.dim.v1.1', 'model.shop.dim.vstable', 'model.shop.dim.v2'].map(unique_id => ({ unique_id, status: 'error', message: 'boom' })) }
  expect(failuresFrom(results, null).map(one => one.name)).toEqual(['dim', 'dim', 'dim'])
})

test('-t dev and --target=dev are the same context, and -x is --fail-fast', async ($, on) => {
  expect(dbtCommand('dbt build -x')?.identity).toEqual(['--fail-fast'])
  const { clock, setBash, band } = await failedBuild($, on, 'dbt build -s orders -t dev')
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders --target=dev' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('the same command from another folder is not the same run: a dev pass leaves a prod failure', async ($, on) => {
  const command = (dir: string) => `cd /proj/profiles/${dir} && dbt build -s orders --project-dir /proj --profiles-dir .`
  const { clock, setBash, band } = await failedBuild($, on, command('prod'))
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: command('dev') })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: command('prod') })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('flags written in another order are the same run', async ($, on) => {
  const { clock, setBash, band } = await failedBuild($, on, 'dbt build -s orders --target prod --full-refresh')
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders --full-refresh --target prod' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})

test('with a manifest too large to read, the artifact\'s versioned failure does not absorb the other version\'s', async ($, on) => {
  const results = { results: [{ unique_id: 'model.shop.orders.v2', status: 'error', message: 'Compilation Error in model orders (models/orders_v2.sql)\n  artifact v2' }] }
  const { clock, prompts, setBash } = await start($, on, { manifestSize: 9 * 1024 * 1024, files: { 'target/run_results.json': JSON.stringify(results) } })
  const block = (file: string, why: string) => `${HEADER}\n06:45:43  Compilation Error in model orders (models/${file})\n  ${why}\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1`
  setBash({ stdout: `${block('orders_v1.sql', 'text v1')}\n${block('orders_v2.sql', 'text v2')}`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders.v1; dbt run -s orders.v2' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  // Each version once: the artifact's v2 stands for the text's v2.
  expect(prompts[0]!.split('\n- ').length - 1).toBe(2)
  const entries = prompts[0]!.split('\n- ').slice(1)
  expect(entries[0]).toContain('artifact v2')
  expect(entries[1]).toMatch(/^model orders \(models\/orders_v1\.sql\)/)
  await band.unmount()
})

test('with a manifest too large to read, one failed version is one entry', async ($, on) => {
  const results = { results: [{ unique_id: 'model.shop.orders.v2', status: 'error', message: 'Compilation Error in model orders\n  artifact v2' }] }
  const { clock, prompts, setBash } = await start($, on, { manifestSize: 9 * 1024 * 1024, files: { 'target/run_results.json': JSON.stringify(results) } })
  setBash({ stdout: `${HEADER}\n06:45:43  Compilation Error in model orders (models/orders_v2.sql)\n  text v2\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders.v2' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'orders' })).toBeDefined()
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]!.split('\n- ').length - 1).toBe(1)
  await band.unmount()
})

const jinjaProfile = (target: string) => `shop:\n  target: ${target}\n  outputs:\n    wh:\n      type: snowflake\n    dev:\n      type: duckdb\n`
for (const [name, target, env, expected] of [
  ['an env_var default is the target when the variable is not set', `"{{ env_var('DBT_TARGET', 'dev') }}"`, {}, 'duckdb 1.10.1'],
  ['an env_var that is set picks the target', `"{{ env_var('DBT_TARGET', 'dev') }}"`, { DBT_TARGET: 'wh' }, 'the profile uses snowflake, but only duckdb is installed'],
  ['any other template is not guessed at', `"{{ var('t') }}"`, {}, /the profile's target is set by a template/],
] as const) {
  test(`doctor adapter: ${name}`, async ($, on) => {
    const { clock } = await start($, on, { env: env as any, profiles: jinjaProfile(target) })
    await $.command.run({ command: 'dbt-doctor', args: '' })
    await clock.settle()
    const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: expected })).toBeDefined()
    await ui.unmount()
  })
}

test('two versions of one model that both failed are both offered, though the artifact holds only one', async ($, on) => {
  const manifest = shopManifest()
  manifest.nodes['model.shop.orders.v2'] = { name: 'orders', resource_type: 'model', package_name: 'shop', version: 2, original_file_path: 'models/orders_v2.sql', config: {}, columns: {}, depends_on: { nodes: [] } }
  const results = { results: [{ unique_id: 'model.shop.orders.v2', status: 'error', message: 'Compilation Error in model orders (models/orders_v2.sql)\n  artifact v2' }] }
  const { clock, prompts, setBash } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(manifest), 'target/run_results.json': JSON.stringify(results) } })
  const block = (file: string, why: string) => `${HEADER}\n06:45:43  Compilation Error in model orders (models/${file})\n  ${why}\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1`
  setBash({ stdout: `${block('orders_v1.sql', 'text v1')}\n${block('orders_v2.sql', 'text v2')}`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders.v1; dbt run -s orders.v2' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]).toContain('(models/orders_v1.sql)')
  expect(prompts[0]).toContain('(models/orders_v2.sql)')
  await band.unmount()
})

kitTest('failures in dbt\'s text are one per resource: the same name in another file, or another kind, is another failure', () => {
  const text = [
    '06:45:43  Compilation Error in model orders (models/orders_v1.sql)',
    '  one',
    '06:45:43  Compilation Error in model orders (models/orders_v2.sql)',
    '  two',
    '06:45:43  Compilation Error in model orders (models/orders_v2.sql)',
    '  two again',
    '06:45:43  Failure in test orders (models/schema.yml)',
  ].join('\n')
  expect(failuresFromText(text).map(one => [one.kind, one.name, one.path])).toEqual([['model', 'orders', 'models/orders_v1.sql'], ['model', 'orders', 'models/orders_v2.sql'], ['test', 'orders', 'models/schema.yml']])
})

// ─── Boolean pairs, environment values never stored ──────────────────────────────────────────────

kitTest('the last of --X and --no-X is the one flag dbt uses', () => {
  expect(dbtCommand('dbt build --empty --no-empty')?.identity).toEqual(['--empty false'])
  expect(dbtCommand('dbt build --no-empty --empty')?.identity).toEqual(['--empty'])
  expect(dbtCommand('dbt build --empty')?.identity).toEqual(['--empty'])
})

for (const flag of ['empty', 'defer', 'favor-state']) {
  test(`--${flag} and --no-${flag} in the other order do not clear each other, and the same order does`, async ($, on) => {
    const { clock, setBash, band } = await failedBuild($, on, `dbt build -s orders --${flag} --no-${flag}`)
    setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
    await $.tool.call({ tool: 'Bash', command: `dbt build -s orders --no-${flag} --${flag}` })
    await clock.settle()
    expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
    await $.tool.call({ tool: 'Bash', command: `dbt build -s orders --${flag} --no-${flag}` })
    await clock.settle()
    expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
    await band.unmount()
  })
}

kitTest('sha256Hex is SHA-256, and an environment value is kept only as a short hash', () => {
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(hashedEnv('DBT_PASSWORD=hunter2')).toMatch(/^DBT_PASSWORD=#[0-9a-f]{8}$/)
  expect(dbtCommand('DBT_PASSWORD=hunter2 dbt run -s o')?.env.join()).not.toContain('hunter2')
})

test('an environment value set for a show is not persisted with its history; one for a run is not kept in the failure', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'DBT_PASSWORD=hunter2 dbt show -s orders' })
  await clock.settle()
  expect(JSON.stringify([...store])).not.toContain('hunter2')
  expect(store.get('dbt-results-history')).toBeDefined()
})

test('no environment value or hash is persisted with the history, while one session still tells values apart', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'DBT_PASSWORD=hunter2 dbt show -s orders' })
  await clock.settle()
  const saved = JSON.stringify([...store])
  expect(saved).toContain('DBT_PASSWORD')
  expect(saved).not.toContain(hashedEnv('DBT_PASSWORD=hunter2').split('#')[1]!)
  expect(saved).not.toContain('#')
  expect(hashedEnv('DBT_PASSWORD=hunter2')).not.toBe(hashedEnv('DBT_PASSWORD=other'))
})

for (const flag of ['debug', 'quiet', 'log-cache-events']) {
  test(`a failed run with --no-${flag} is cleared by a plain passing run`, async ($, on) => {
    expect(dbtCommand(`dbt build -s orders --no-${flag}`)?.identity).toEqual([])
    const { clock, setBash, band } = await failedBuild($, on, `dbt build -s orders --no-${flag}`)
    setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
    await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
    await clock.settle()
    expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
    await band.unmount()
  })
}

test('a failure under an environment value is cleared only by a run with the same value', async ($, on) => {
  const { clock, setBash, band } = await failedBuild($, on, 'DBT_PASSWORD=hunter2 dbt build -s orders')
  setBash({ stdout: `${HEADER}\n${RUN_PASSED}` })
  await $.tool.call({ tool: 'Bash', command: 'DBT_PASSWORD=other dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'DBT_PASSWORD=hunter2 dbt build -s orders' })
  await clock.settle()
  expect(await band.find({ key: 'dbt-explain' })).toBeUndefined()
  await band.unmount()
})
