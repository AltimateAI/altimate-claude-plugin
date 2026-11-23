import { expect, mock, test as kitTest } from 'claude-code/testing'

import {
  columnDrift,
  undocumentedByEdit,
  columnWidths,
  dbtCommand,
  dbtCommands,
  dbtVerdict,
  hashedEnv,
  sha256Hex,
  debugInfo,
  doctorNote,
  failuresFrom,
  failuresFromText,
  logErrors,
  profilesError,
  clearRedactions,
  redactionForms,
  redactValues,
  scrubDbt,
  setRedactions,
  withoutDropped,
  withoutValueFragment,
  modelContext,
  modelContextNote,
  nodeForFile,
  projectPaths,
  replayArgv,
  budgetHistory,
  dropOldest,
  fitSaved,
  savedRows,
  saysFailed,
  targetPath,
  showPreview,
  textTable,
  versionInfo,
} from './dbt-mods-core'
import { CHECK_HOLD_MS, MANIFEST_SLICE, PROFILE_REDACT, PROFILE_TYPE, RUN_FAILURES } from './dbt-mods'

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
function showLog(rows: Record<string, unknown>[], node: string | null, invocation?: string) {
  return [
    JSON.stringify({ data: { msg: '' }, info: { code: 'Z017', level: 'info', msg: '', ...(invocation ? { invocation_id: invocation } : {}) } }),
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
  show?: { rows?: Record<string, unknown>[]; error?: string; node?: string | null; onlyName?: string; mustInclude?: string; raw?: { exitCode: number; stdout: string; stderr?: string }; writes?: string; claudeWrites?: string; invocation?: string }
  /** The node names `dbt ls` prints; the default is none. */
  listed?: (string | { name: string; resource_type: string })[]
  /** What stops dbt from running: its spawn failing, or the shell finding no such command. Asked at each run. */
  dbtMissing?: () => 'spawn' | 'not-found' | null
  /** What `dbt debug` prints and exits with. */
  debug?: { exitCode: number; stdout: string }
  /** The plugin store refuses a write that leaves more than this many characters of JSON in all. */
  storeLimit?: number

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
  /** No project .venv: dbt is the one on PATH, its launcher naming this interpreter. */
  pathDbtPython?: string
  /** run_results.json's size: over 4 MiB $.fs.read refuses it and its failures come through the project's Python. */
  runResultsSize?: number
  /** What the project's Python prints for the run_results script. */
  runFailures?: { exitCode: number; stdout: string }
  /** What the project's Python prints for the manifest slice; the default is the manifest's nodes. */
  sliceAnswer?: { exitCode: number; stdout: string }
  /** While this answers true, a read of the plugin's store fails. */
  storeGetFails?: () => boolean
  /** The values the project's Python prints for the redaction script. */
  redact?: string[]
  /** The profile's value script does not answer until this settles. */
  holdRedact?: Promise<void>
  /** Collects what is written to the redaction-aware run_results script's standard input. */
  stdins?: { argv: string[]; stdin: string | undefined }[]
  /** The values the redaction script prints, given the assignments it was sent on stdin. */
  redactFrom?: (env: Record<string, string>) => string[]
  /** The same, for the profiles.yml at one path (the script's second argument). */
  redactBy?: Record<string, string[]>
  /** More project folders, each with a dbt_project.yml. */
  extraProjects?: string[]
  /** What the project's Python prints for the profile script; the default is an ok duckdb output. */
  profileAnswer?: { exitCode: number; stdout: string }
  /** What the plugin's store held from an earlier session. */
  stored?: Record<string, unknown>
  /** Extra project files, by project-relative path. */
  files?: Record<string, string>
  /** No manifest until dbt show writes this one. */
  manifestAfterShow?: unknown
  /** The first Edit waits for this before its result returns. */
  holdEdit?: Promise<void>
  /** Collects what the plugin writes to the debug log. */
  logs?: string[]
  /** While set, a read of the session's root waits for it. */
  holdRoot?: Promise<void>
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
  /** The exit code of the failing `dbt deps`; the default is 1. */
  depsExit?: number
  /** `dbt ls` exits non-zero. */
  listFails?: boolean
  /** A file whose stat waits for `until` while it is set. */
  statGate?: { path: string; until?: Promise<void> }
  /** The rows `dbt show --inline "select * from {{ ref(…) }}"` gives of the model's relation as built; unset, dbt cannot show it (never built). */
  built?: () => Record<string, unknown>[] | null
  /** What altimate-code's dbt_map_relations answers (its mappings); unset, the tool is not there. */
  mapRelations?: unknown[]
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
  const envs: Record<string, string>[] = []
  // dbt processes and manifest reads, in the order they happened.
  const order: string[] = []
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
  if (options.pathDbtPython) {
    delete files['.venv/bin/dbt']
    delete files['.venv/bin/python']
  }
  const python = options.pathDbtPython ?? '/proj/.venv/bin/python'
  if (options.manifestAfterShow && !options.files?.['target/manifest.json']) delete files['target/manifest.json']
  if (options.target) {
    files[`${options.target}/manifest.json`] = files['target/manifest.json']!
    delete files['target/manifest.json']
    mtimes[`${options.target}/manifest.json`] = mtimes['target/manifest.json']!
  }
  const exists = (path: string) => path === ROOT || (options.extraProjects ?? []).some(one => path === one || path === `${one}/dbt_project.yml`) || (path.startsWith(`${ROOT}/`) && (path.slice(ROOT.length + 1) in files || Object.keys(files).some(one => one.startsWith(`${path.slice(ROOT.length + 1)}/`))))
  const registered: string[] = []
  const storeGets: string[] = []
  const redactSent: { argv: string[]; stdin: string | undefined }[] = []
  const mapAsked: Record<string, unknown>[] = []
  on('command.register', (_: unknown, e: { name: string }) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.root', async () => {
    await options.holdRoot
    return { value: options.sessionRoot ?? ROOT }
  })
  // Where Claude's shell is: the session folder unless a test moved it.
  let cwdCalls = 0
  on('session.cwd', async () => {
    // The first read is the defer feature's gate (features/defer.tsx), before the call starts; the hold is on
    // the dbt helpers' own read of the folder, the second.
    if (options.holdCwd && ++cwdCalls === 8) await options.holdCwd
    return { value: options.cwd ?? ROOT }
  })
  const opened: string[] = []
  const sizes: { id: string; title: string; columns?: number; rows?: number }[] = []
  on('ui.open', (_: unknown, e: { id: string; title: string; columns?: number; rows?: number; focus?: boolean }) => {
    opened.push(`${e.id}${e.focus ? ':focus' : ''}`)
    sizes.push({ id: e.id, title: e.title, columns: e.columns, rows: e.rows })
    return { value: { isPlaced: true } }
  })
  on('ui.log', (_: unknown, e: { text: string }) => {
    options.logs?.push(e.text)
    return { value: undefined }
  })
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
  on('store.get', (_: unknown, e: { key: string }) => {
    storeGets.push(e.key)
    if (options.storeGetFails?.()) throw new Error('store unavailable')
    return { value: store.get(e.key) }
  })
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    if (options.storeLimit !== undefined) {
      const others = [...store].filter(([key]) => key !== e.key).reduce((sum, [, value]) => sum + JSON.stringify(value).length, 0)
      if (others + JSON.stringify(e.value).length > options.storeLimit) throw new Error('the plugin store is full')
    }
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
    const size = /(^|\/)manifest\.json$/.test(rel) && options.manifestSize ? options.manifestSize : rel === 'target/run_results.json' && options.runResultsSize ? options.runResultsSize : (files[rel]?.length ?? 0)
    return { value: { kind: isDir ? 'dir' : 'file', size, mtimeMs, isLink: false } }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (options.pathDbtPython && e.path === '/x/bin/dbt') return { value: `#!${options.pathDbtPython}\nimport sys\n` }
    const rel = e.path.slice(ROOT.length + 1)
    if (rel.endsWith('manifest.json')) order.push(`read ${rel}`)
    if (!(rel in files)) throw new Error('ENOENT')
    if (rel === 'target/run_results.json' && (options.runResultsSize ?? 0) > 4 * 1024 * 1024) throw new Error('file is larger than 4 MiB')
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
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string; stdin?: string; env?: Record<string, string> } }) => {
    runs.push([...e.argv])
    envs.push(e.init?.env ?? {})
    if (e.argv[0] === DBT) order.push(`dbt ${e.argv[1]}`)
    // Where this dbt writes its artifacts: DBT_TARGET_PATH when set, else the project's target folder.
    const given = e.init?.env?.DBT_TARGET_PATH
    const out = given ? (given.startsWith(`${ROOT}/`) ? given.slice(ROOT.length + 1) : given) : (options.target ?? 'target')
    if (e.argv[2] === PROFILE_REDACT) {
      redactSent.push({ argv: [...e.argv], stdin: e.init?.stdin })
      await options.holdRedact
    }
    if (e.argv[2] === RUN_FAILURES) options.stdins?.push({ argv: [...e.argv], stdin: e.init?.stdin })
    cwds.push(e.init?.cwd ?? '')
    // The first dbt show waits until the test lets it go.
    if (options.holdShow && !held && e.argv.includes('show') && shows++ >= (options.holdShowAfter ?? 0)) {
      held = true
      await options.holdShow
    }
    const [bin, verb] = e.argv
    const missing = options.dbtMissing?.()
    if (missing && (bin === DBT || bin === 'dbt')) {
      if (missing === 'spawn') throw new Error(`ENOENT: no such file or directory, posix_spawn '${bin}'`)
      return { value: { exitCode: 127, stdout: '', stderr: 'zsh: command not found: dbt' } }
    }
    if (options.pathDbtPython && bin === 'which') return { value: { exitCode: 0, stdout: '/x/bin/dbt\n', stderr: '' } }
    if (bin === 'printenv') {
      const value = { HOME: '/home/me', ...options.env }[verb as string]
      return { value: { exitCode: value ? 0 : 1, stdout: value ? `${value}\n` : '', stderr: '' } }
    }
    // The project's Python: its version, or the slice of a manifest too big to read here.
    if (bin === python && verb === '-c' && e.argv[2] === PROFILE_TYPE) {
      // The script itself is checked below; here the interpreter answers what it would print.
      return { value: { ...(options.profileAnswer ?? { exitCode: 0, stdout: '{"status":"ok","profile":"shop","target":"dev","type":"duckdb"}' }), stderr: '' } }
    }
    if (bin === python && verb === '-c' && e.argv[2] === PROFILE_REDACT) return { value: { exitCode: 0, stdout: JSON.stringify({ redact: options.redactFrom?.(JSON.parse(e.init?.stdin ?? '{}').env ?? {}) ?? options.redactBy?.[e.argv[4] as string] ?? options.redact ?? [] }), stderr: '' } }
    if (bin === python && verb === '-c' && e.argv[2] === RUN_FAILURES) return { value: { ...(options.runFailures ?? { exitCode: 0, stdout: JSON.stringify({ results: [] }) }), stderr: '' } }
    if (bin === python && verb === '-c' && options.sliceAnswer) return { value: { ...options.sliceAnswer, stderr: '' } }
    if (bin === python && verb === '-c') return { value: { exitCode: 0, stdout: JSON.stringify({ nodes: MANIFEST.nodes, parent_map: MANIFEST.parent_map, child_map: MANIFEST.child_map }), stderr: '' } }
    if (bin === python) return { value: { exitCode: 0, stdout: 'Python 3.13.13\n', stderr: '' } }
    if (e.argv.includes('dbt_map_relations')) {
      if (!options.mapRelations) return { value: { exitCode: 1, stdout: '', stderr: 'unknown tool: dbt_map_relations' } }
      mapAsked.push(JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1])))
      return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: { success: true, mappings: options.mapRelations } }), stderr: '' } }
    }
    if (bin !== (options.pathDbtPython ? 'dbt' : DBT)) return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    if (verb === '--version') return { value: { exitCode: 0, stdout: options.version ?? VERSION, stderr: '' } }
    if (verb === 'debug') return { value: { ...(options.debug ?? { exitCode: 0, stdout: DEBUG }), stderr: '' } }
    if (verb === 'ls' && options.listFails) return { value: { exitCode: 1, stdout: '', stderr: 'ls failed' } }
    if (verb === 'ls') return { value: { exitCode: 0, stdout: `${(options.listed ?? []).map(one => JSON.stringify(typeof one === 'string' ? { name: one } : one)).join('\n')}\n`, stderr: '' } }
    if (verb === 'deps' && options.depsFails) return { value: { exitCode: options.depsExit ?? 1, stdout: '', stderr: options.depsFails } }
    if (verb === 'parse') {
      mtimes['target/manifest.json'] = 10_000
      return { value: { exitCode: 0, stdout: 'Performance info: target/perf_info.json', stderr: '' } }
    }
    if (verb === 'show' && e.argv.includes('--inline') && /select \* from \{\{ ref\(/.test(e.argv[e.argv.indexOf('--inline') + 1] ?? '')) {
      const rows = options.built?.()
      return { value: rows ? { exitCode: 0, stdout: showLog(rows, null as any), stderr: '' } : { exitCode: 1, stdout: errorLog('Catalog Error: Table with name orders does not exist!'), stderr: '' } }
    }
    if (verb === 'show') {
      const show = options.show ?? { rows: [{ order_id: 1, amount: 10 }] }
      // A dbt show writes run_results.json to its own artifact folder; a run of Claude's that ends meanwhile writes the project's.
      if (show.writes) files[`${out}/run_results.json`] = JSON.stringify({ ...RUN_RESULTS, metadata: { invocation_id: show.writes, generated_at: 'x' } })
      if (show.claudeWrites) files[`${options.target ?? 'target'}/run_results.json`] = JSON.stringify({ ...RUN_RESULTS, metadata: { invocation_id: show.claudeWrites, generated_at: 'x' } })
      // dbt parses the project and writes the manifest to its artifact folder, every time.
      const parsed = options.manifestAfterShow ? JSON.stringify(options.manifestAfterShow) : files[`${options.target ?? 'target'}/manifest.json`]
      if (parsed) {
        files[`${out}/manifest.json`] = parsed
        mtimes[`${out}/manifest.json`] = (mtimes[`${out}/manifest.json`] ?? 1_000) + 1
      }
      // dbt selects a model by its name: the one the test's manifest gives the file, if it gave one.
      const asked = e.argv[e.argv.indexOf('--select') + 1]
      if (show.onlyName && asked !== show.onlyName) return { value: { exitCode: 0, stdout: JSON.stringify({ info: { code: 'Q043', level: 'warn', msg: 'No nodes selected!' } }), stderr: '' } }
      // dbt prints a node's preview only when its name is in the selection string.
      if (show.mustInclude && !asked?.includes(show.mustInclude)) return { value: { exitCode: 0, stdout: JSON.stringify({ info: { code: 'Q043', level: 'warn', msg: 'No nodes selected!' } }), stderr: '' } }
      // A comma is an intersection: every bare name in it must be the node's own name, or nothing is selected.
      const nodeName = show.node === undefined ? (asked?.startsWith('path:') ? asked.slice(5).split(',')[0]!.split('/').pop()!.replace(/\.sql$/, '') : asked) : show.node
      if (asked?.includes(',') && nodeName && asked.split(',').some(term => !term.includes(':') && term !== nodeName)) return { value: { exitCode: 0, stdout: JSON.stringify({ info: { code: 'Q043', level: 'warn', msg: 'No nodes selected!' } }), stderr: '' } }
      if (show.raw) return { value: { exitCode: show.raw.exitCode, stdout: show.raw.stdout, stderr: show.raw.stderr ?? '' } }
      if (show.error) return { value: { exitCode: 2, stdout: errorLog(show.error), stderr: '' } }
      // A selection that matches no node: dbt exits 0 and previews nothing.
      if (show.node === 'none') return { value: { exitCode: 0, stdout: JSON.stringify({ info: { code: 'Q043', level: 'warn', msg: 'No nodes selected!' } }), stderr: '' } }
      // dbt names the node it shows: `path:models/x.sql,package:p` selects the model x.
      const selected = e.argv.includes("--select") ? e.argv[e.argv.indexOf("--select") + 1]! : null
      const select = selected?.startsWith("path:") ? selected.slice(5).split(',')[0]!.split('/').pop()!.replace(/\.sql$/, '') : selected
      return { value: { exitCode: 0, stdout: showLog(show.rows ?? [], show.node === undefined ? select : show.node, show.invocation), stderr: '' } }
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
  return { mapAsked, redactSent, clock, runs, envs, order, cwds, toasts, prompts, store, registered, storeGets, mtimes, opened, sizes, files, setBash: (next: typeof bash) => void (bash = next) }
}

// ─── What the helpers read from dbt ─────────────────────────────────────────────────────────────

kitTest('a text table is cut at the rule\'s pipes, so a value with a pipe stays whole; one that does not fit is declined', () => {
  const table = (...lines: string[]) => lines.join('\n')
  expect(textTable(table('| value | other |', '| ----- | ----- |', '| a|b   | c     |'))).toEqual({ columns: ['value', 'other'], rows: [['a|b', 'c']] })
  expect(textTable(table('| id | note  |', '| -- | ----- |', '| 1  | x|y|z |'))).toEqual({ columns: ['id', 'note'], rows: [[1, 'x|y|z']] })
  // agate pads by code points: an emoji is one cell.
  expect(textTable(table('| value | other |', '| ----- | ----- |', '| 🙂🙂    | c     |', '| a|🙂   | d     |'))).toEqual({ columns: ['value', 'other'], rows: [['🙂🙂', 'c'], ['a|🙂', 'd']] })
  // A line out of step with the rule is not guessed at: nothing is captured.
  expect(textTable(table('| value | other |', '| ----- | ----- |', '| a|b  | c     |'))).toBeNull()
  // A column with a leading-zero code stays text, as dbt's JSON gives it; 0 and 0.5 are still numbers.
  expect(textTable(table('| zip   | n   |', '| ----- | --- |', '| 00123 | 0   |', '| 00501 | 0.5 |'))).toEqual({ columns: ['zip', 'n'], rows: [['00123', 0], ['00501', 0.5]] })
  // A column of numbers comes back as numbers, the way dbt's JSON output gives them, so Re-run shows them the same.
  expect(textTable(table('| region  | revenue   | id                  |', '| ------- | --------- | ------------------- |', '| central | 21,109.09 | 1234567890123456789 |', '| east    | 20,476.10 | 7                   |'))).toEqual({
    columns: ['region', 'revenue', 'id'],
    rows: [['central', 21109.09, '1234567890123456789'], ['east', 20476.1, 7]],
  })
  expect(textTable(table('| value | other |', '| ----- | ----- |', '| a     | c     |', '| a | b | c |'))).toBeNull()
  // Through dbt's JSON logs, a text preview takes the same road.
  const log = (preview: string) => JSON.stringify({ info: { code: 'Q041' }, data: { preview, output_format: 'text' } })
  expect(showPreview(log(table('| value | other |', '| ----- | ----- |', '| a|b   | c     |')))?.rows).toEqual([['a|b', 'c']])
  expect(showPreview(log(table('| value | other |', '| ----- | ----- |', '| a|b  | c     |')))).toBeNull()
})

kitTest('dbt show JSON logs give the rows in dbt\'s column order; the text table drops the elided column', () => {
  expect(showPreview(showLog([{ b: 1, a: 'x' }, { b: 2, a: null }], 'orders'))).toEqual({ columns: ['b', 'a'], rows: [[1, 'x'], [2, null]], node: 'orders' })
  expect(showPreview('no preview here')).toBeNull()
  const text = '\u001b[0m06:36:55  Previewing node \'customers\':\n| customer_id | first_name | ... |\n| ----------- | ---------- | --- |\n|           1 | Michael    | ... |\n'
  expect(textTable(text)).toEqual({ columns: ['customer_id', 'first_name'], rows: [[1, 'Michael']] })
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
  expect(dbtCommand('dbt build -s orders')).toEqual({ verb: 'build', select: 'orders', inline: null, limit: null, options: [], identity: [], at: 0, cds: [], end: 9, argv: ['dbt', 'build', '-s', 'orders'], replayable: true, env: [], profilesDir: null, profile: null, assignments: [] })
  expect(dbtCommand('cd x && .venv/bin/dbt show --select customers --limit 5')).toEqual({ verb: 'show', select: 'customers', inline: null, limit: 5, options: [], identity: ['--limit 5'], at: 8, cds: ['x'], end: 26, argv: ['.venv/bin/dbt', 'show', '--select', 'customers', '--limit', '5'], replayable: true, env: [], profilesDir: null, profile: null, assignments: [] })
  // Redirections are the shell's: they are neither selection nor argv.
  expect(dbtCommand('dbt show -s orders 2>&1 | tail -20')?.argv).toEqual(['dbt', 'show', '-s', 'orders'])
  expect(dbtCommand('dbt run -s orders > out.txt 2> err.txt')?.select).toBe('orders')
  // What the shell expanded cannot be repeated word for word.
  expect(dbtCommand('DBT_PROFILES_DIR=. dbt show -s x')?.replayable).toBe(false)
  expect(dbtCommand('dbt show --target $T -s x')?.replayable).toBe(false)
  // A command split with `\` across lines is one command.
  expect(dbtCommand('dbt build \\\n  --select stg_x \\\n  --limit 10')).toEqual({ verb: 'build', select: 'stg_x', inline: null, limit: 10, options: [], identity: ['--limit 10'], at: 0, cds: [], end: 9, argv: ['dbt', 'build', '--select', 'stg_x', '--limit', '10'], replayable: true, env: [], profilesDir: null, profile: null, assignments: [] })
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
  expect(showPreview(JSON.stringify({ data: { output_format: 'text', node_name: 'm', preview: '| a | b |\n| - | - |\n| 1 | 2 |' }, info: { code: 'Q041' } }))?.rows).toEqual([[1, 2]])
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
  expect(dbtCommand(`dbt show a 'b c' "d \\"e\\"" f\\ g`)?.argv).toEqual(['dbt', 'show', 'a', 'b c', 'd "e"', 'f g'])
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
  expect(dbtCommand("altimate run 'Fix the failing test, then re-run `dbt build -s orders`' --agent builder")).toBeNull()
  expect(dbtCommand('altimate run "Fix the failing test, then re-run dbt build -s orders" --agent builder')).toBeNull()
  // Inside double quotes a backtick still runs its command: the shell starts that dbt, so it is one.
  expect(dbtCommand('altimate run "Fix the failing test, then re-run `dbt build -s orders`" --agent builder')?.verb).toBe('build')
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
  // Room to spare is used: a long value is cut only as far as the room needs.
  expect(columnWidths({ columns: ['a', 'b', 'c'], rows: [['x'.repeat(30), 'y'.repeat(30), 'z'.repeat(30)]] }, 80)).toEqual([25, 25, 24])
  expect(columnWidths({ columns: ['id', 'note'], rows: [['1', 'n'.repeat(70)]] }, 100)).toEqual([3, 70])
  // Seven columns in a narrow pane: every cell shrinks to its floor and the table is no wider than the room allows beyond that.
  const seven = { columns: ['customer_id', 'first_name', 'last_name', 'first_order', 'most_recent_order', 'number_of_orders', 'lifetime_value'], rows: [['1', 'Michael', 'P.', '2018-01-01', '2018-02-10', '2', '33']] }
  expect(columnWidths(seven, 31).every(one => one >= 3)).toBe(true)
  // A pane about 70 wide: every value is whole (the dates are 10), the headers share what is left, and the table fills the room.
  const mid = columnWidths(seven, 68)
  expect(mid[3]).toBeGreaterThanOrEqual(10)
  expect(mid[4]).toBeGreaterThanOrEqual(10)
  expect(mid.reduce((a, b) => a + b, 0) + 18).toBe(68)
  const roomy = columnWidths(seven, 80)
  expect(roomy.reduce((a, b) => a + b, 0) + 18).toBeLessThanOrEqual(80)
  expect(roomy[3]).toBe(11)
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
  expect(toasts).toContain('◆ model context · orders: table · 2 columns in schema.yml · 2 tests · depth 2↑ 1↓')

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

  // One show per edit, and no dbt ls when the manifest already names the model.
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(1)
  expect(runs.some(argv => argv[1] === 'ls')).toBe(false)
  // Only the model runs: its tests would fail on the renamed column and be reported as the model's error.
  expect(runs.find(argv => argv[1] === 'show' && !argv.includes('--inline'))).toEqual([DBT, 'show', '--select', 'path:models/orders.sql,package:shop,orders', '--indirect-selection', 'empty', '--limit', '1', '--output', 'json', '--log-format', 'json'])
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

test('from integration_tests with no manifest there, dbt ls names the file\'s model and version, so only that version runs', async ($, on) => {
  const { clock, runs } = await start($, on, {
    show: { rows: [{ order_id: 1, amount: 10 }], node: 'orders.v2' },
    listed: [{ name: 'orders', version: 1, original_file_path: 'models/orders_v1.sql' } as any, { name: 'orders', version: 2, original_file_path: 'models/orders.sql' } as any],
    files: {
      'packages.yml': 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n',
      'integration_tests/dbt_project.yml': "name: 'shop_tests'\n",
      'integration_tests/packages.yml': 'packages:\n  - local: ../\n',
      'integration_tests/dbt_packages/shop/dbt_project.yml': "name: 'shop'\n",
    },
  })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  const ls = runs.find(argv => argv[1] === 'ls')!
  expect(ls.slice(0, 4)).toEqual([DBT, 'ls', '--select', 'package:shop'])
  expect(runs.find(argv => argv[1] === 'show' && !argv.includes('--inline'))!.slice(0, 4)).toEqual([DBT, 'show', '--select', 'package:shop,orders.v2'])
})

kitTest('a column the model returned before the edit is not the edit\'s gap; names match exactly; with nothing to compare, every one is', () => {
  expect(undocumentedByEdit(['status', 'amount_cents'], ['order_id', 'amount', 'status'])).toEqual({ fresh: ['amount_cents'], old: ['status'] })
  expect(undocumentedByEdit(['amount'], ['id', 'Amount'])).toEqual({ fresh: ['amount'], old: [] })
  expect(undocumentedByEdit(['status'], ['status'], ['status'])).toEqual({ fresh: ['status'], old: [] })
  expect(undocumentedByEdit(['status'], null)).toEqual({ fresh: ['status'], old: [] })
})

test('only the columns an edit left undocumented are its gaps, from what the warehouse returned before; older ones are said once, quietly', async ($, on) => {
  const show: Options['show'] = { rows: [{ order_id: 1, amount: 10, status: 'placed', amount_cents: 1000 }] }
  // The model as it is built: order_id, amount and status; status was never documented.
  const { clock, runs } = await start($, on, { show, built: () => [{ order_id: 1, amount: 10, status: 'placed' }] })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  // dbt shows the model's built relation: the columns it returned before the edit. No SQL is read for it.
  // In a folder of its own, so the manifest the check's show wrote stays the one it reports.
  expect(runs.find(argv => argv.includes('--inline'))).toEqual([DBT, 'show', '--inline', "select * from {{ ref('orders') }}", '--limit', '1', '--output', 'json', '--log-format', 'json', '--target-path', `${ROOT}/target/.altimate-plugin/baseline`])
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('- returned but not documented in schema.yml: amount_cents\n')
  expect(note).toContain("- already undocumented before this edit (not this edit's doing; nothing to fix for it): status")
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /undocumented amount_cents · 1 undocumented before this edit/ })).toBeDefined()
  await band.unmount()
  const pane = await $.ui.mount({ ...CHECK, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '  not documented, from before this edit' })).toBeDefined()
  await pane.unmount()

  // A later edit, the new column still undocumented: still the edit's. The built relation is asked once only.
  const rewritten: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select  *', new_string: 'select   *' })
  await clock.settle()
  expect(rewritten.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toContain('- returned but not documented in schema.yml: amount_cents\n')
  expect(runs.filter(argv => argv.includes('--inline')).length).toBe(1)

  // The column dropped again: nothing is the edit's gap, and the older ones are not said again.
  show.rows = [{ order_id: 1, amount: 10, status: 'placed' }]
  const again: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select   *', new_string: 'select *' })
  await clock.settle()
  const second = again.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(second).not.toContain('not documented')
  expect(second).not.toContain('already undocumented')
  const quiet = await $.ui.mount({ ...CHECK, surface: 'terminal' })
  expect(await quiet.find({ type: 'Text', text: 'Compiles and runs; no new gaps with schema.yml (some columns were undocumented before this edit)' })).toBeDefined()
  await quiet.unmount()
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /no new gaps with schema\.yml/ })).toBeDefined()
  expect(await after.find({ type: 'Text', text: /undocumented before this edit/ })).toBeUndefined()
  await after.unmount()
})

test('a package tested from integration_tests is compiled and validated from there, where its packages are installed', async ($, on) => {
  const { clock, runs, cwds, toasts } = await start($, on, {
    pathDbtPython: '/usr/bin/python3',
    show: { rows: [{ order_id: 1, amount: 10 }], node: 'orders' },
    // No manifest in integration_tests: dbt ls names the file's model there.
    listed: [{ name: 'orders', original_file_path: 'models/orders.sql' } as any],
    files: {
      'packages.yml': 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n',
      'integration_tests/dbt_project.yml': "name: 'shop_tests'\n",
      'integration_tests/packages.yml': 'packages:\n  - local: ../\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n',
      'integration_tests/dbt_packages/shop/dbt_project.yml': "name: 'shop'\n",
      // The package's own packages installed too: its models are still run where its tests enable them.
      'dbt_packages/dbt_utils/dbt_project.yml': "name: 'dbt_utils'\n",
    },
  })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  const at = runs.findIndex(argv => argv[1] === 'show' && !argv.includes('--inline'))
  // `path:` would read from integration_tests: the package and the model's name select it there.
  expect(runs[at]).toEqual(['dbt', 'show', '--select', 'package:shop,orders', '--indirect-selection', 'empty', '--limit', '1', '--output', 'json', '--log-format', 'json'])
  expect(cwds[at]).toBe(`${ROOT}/integration_tests`)
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('- compiled and ran from integration_tests (the project that installs this package); the warehouse returned 2 columns.')
  expect(toasts).toContain('✓ orders · compiled and validated against the warehouse')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /match schema\.yml · ran from integration_tests/ })).toBeDefined()
  await band.unmount()
})

test('from integration_tests the package repo\'s own dbt is used, and a versioned model is selected by its version', async ($, on) => {
  const versioned = { ...MANIFEST, nodes: { ...MANIFEST.nodes, 'model.shop.orders': { ...(MANIFEST.nodes as any)['model.shop.orders'], version: 2 } } }
  const { clock, runs, cwds } = await start($, on, {
    show: { rows: [{ order_id: 1, amount: 10 }], node: 'orders.v2' },
    // The saved manifest there still maps the file to version 2; dbt ls says what it is now.
    listed: [{ name: 'orders', version: 1, original_file_path: 'models/orders_v1.sql' } as any, { name: 'orders', version: 2, original_file_path: 'models/orders.sql' } as any],
    files: {
      'packages.yml': 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n',
      'integration_tests/dbt_project.yml': "name: 'shop_tests'\n",
      'integration_tests/packages.yml': 'packages:\n  - local: ../\n',
      'integration_tests/dbt_packages/shop/dbt_project.yml': "name: 'shop'\n",
      'integration_tests/target/manifest.json': JSON.stringify(versioned),
    },
  })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  const at = runs.findIndex(argv => argv[1] === 'show' && !argv.includes('--inline'))
  // The repo's .venv dbt (integration_tests has none), run in integration_tests, for version 2 only.
  expect(runs[at]!.slice(0, 4)).toEqual([DBT, 'show', '--select', 'package:shop,orders.v2'])
  expect(cwds[at]).toBe(`${ROOT}/integration_tests`)
})

test('from integration_tests, a file whose model dbt does not list there runs nothing, even when another model has the file\'s name', async ($, on) => {
  const { clock, runs } = await start($, on, {
    listed: [{ name: 'orders', version: 2, original_file_path: 'models/legacy.sql' } as any, { name: 'orders', original_file_path: 'models/other/orders.sql' } as any],
    files: {
      'packages.yml': 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n',
      'integration_tests/dbt_project.yml': "name: 'shop_tests'\n",
      'integration_tests/packages.yml': 'packages:\n  - local: ../\n',
      'integration_tests/dbt_packages/shop/dbt_project.yml': "name: 'shop'\n",
    },
  })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  expect(runs.some(argv => argv[1] === 'show' && !argv.includes('--inline'))).toBe(false)
  expect(result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toContain('- not checked: dbt has no model for this file in the project that installs this package')
})

test('a column whose documentation an edit removed is the edit\'s gap, though the model returned it before', async ($, on) => {
  // amount was documented and returned; the edit removes it from schema.yml.
  const undocumented = { ...MANIFEST, nodes: { ...MANIFEST.nodes, 'model.shop.orders': { ...(MANIFEST.nodes as any)['model.shop.orders'], columns: { order_id: { name: 'order_id' } } } } }
  const { clock } = await start($, on, { show: { rows: [{ order_id: 1, amount: 10 }] }, built: () => [{ order_id: 1, amount: 10 }], manifestAfterShow: undocumented, files: { 'target/manifest.json': JSON.stringify(MANIFEST) } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('- returned but not documented in schema.yml: amount')
  expect(note).not.toContain('already undocumented')
})

test('after /clear, the next conversation compares with the model as built again, not with the last conversation\'s edits', async ($, on) => {
  const show: Options['show'] = { rows: [{ order_id: 1, amount: 10, amount_cents: 1000 }] }
  let built: Record<string, unknown>[] = [{ order_id: 1, amount: 10 }]
  const { clock } = await start($, on, { show, built: () => built })
  const first: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  expect(first.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toContain('- returned but not documented in schema.yml: amount_cents')
  // The edit was built, then the conversation cleared.
  built = [{ order_id: 1, amount: 10, amount_cents: 1000 }]
  await $.session.end({ reason: 'clear' } as any)
  await clock.settle()
  const later: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select  *', new_string: 'select *' })
  await clock.settle()
  const note = later.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).not.toContain('- returned but not documented in schema.yml: amount_cents')
  expect(note).toContain('already undocumented before this edit')
})

test('from integration_tests, a saved manifest that maps the file to an older version is not trusted: dbt ls says which version it is now', async ($, on) => {
  const stale = { ...MANIFEST, nodes: { ...MANIFEST.nodes, 'model.shop.orders': { ...(MANIFEST.nodes as any)['model.shop.orders'], version: 1 } } }
  const { clock, runs } = await start($, on, {
    show: { rows: [{ order_id: 1, amount: 10 }], node: 'orders.v2' },
    listed: [{ name: 'orders', version: 1, original_file_path: 'models/orders_v1.sql' } as any, { name: 'orders', version: 2, original_file_path: 'models/orders.sql' } as any],
    files: {
      'packages.yml': 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n',
      'integration_tests/dbt_project.yml': "name: 'shop_tests'\n",
      'integration_tests/packages.yml': 'packages:\n  - local: ../\n',
      'integration_tests/dbt_packages/shop/dbt_project.yml': "name: 'shop'\n",
      'integration_tests/target/manifest.json': JSON.stringify(stale),
    },
  })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  expect(runs.find(argv => argv[1] === 'show' && !argv.includes('--inline'))!.slice(0, 4)).toEqual([DBT, 'show', '--select', 'package:shop,orders.v2'])
})

test('from integration_tests, dbt ls failing on a compilation error shows that error, not "no model"', async ($, on) => {
  const { clock } = await start($, on, {
    listFails: true,
    files: {
      'packages.yml': 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n',
      'integration_tests/dbt_project.yml': "name: 'shop_tests'\n",
      'integration_tests/packages.yml': 'packages:\n  - local: ../\n',
      'integration_tests/dbt_packages/shop/dbt_project.yml': "name: 'shop'\n",
    },
  })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('- FAILED. dbt reported:')
  expect(note).not.toContain('no model for this file')
})

test('a project whose packages are not installed gets a one-line note, not a failure, when nothing installs it elsewhere', async ($, on) => {
  const { clock, toasts } = await start($, on, {
    show: { error: 'dbt expects 1 package(s) based on packages specified in packages.yml, but found only 0 package(s) installed in dbt_packages. Run "dbt deps"' },
    files: { 'packages.yml': 'packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.0.0\n' },
  })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).not.toContain('FAILED')
  expect(note).toContain("- not checked: dbt's packages are not installed in this project, so dbt could not compile it (run `dbt deps` there, or run dbt from the project that installs this package).")
  expect(toasts.some(one => one.startsWith('✖'))).toBe(false)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /^◦ Compile & validate / })).toBeDefined()
  await band.unmount()
})

test('a table the compiled SQL reads that is a dbt node but not a dependency is flagged, from altimate-code\'s dbt_map_relations', async ($, on) => {
  // dbt compiled the edited model: it reads stg_orders by its table, so dbt no longer lists it among the model's parents.
  const compiled = { ...MANIFEST, parent_map: { ...(MANIFEST as any).parent_map, 'model.shop.orders': [] }, nodes: { ...MANIFEST.nodes, 'model.shop.orders': { ...(MANIFEST.nodes as any)['model.shop.orders'], depends_on: { nodes: [] } } } }
  const mapRelations = [{ raw: 'main.stg_orders', replaceWith: "{{ ref('stg_orders') }}", match: 'partial', candidates: [{ uniqueId: 'model.shop.stg_orders', replaceWith: "{{ ref('stg_orders') }}", kind: 'model', name: 'stg_orders', relationName: '"shop"."main"."stg_orders"', match: 'partial' }] }]
  const { clock, toasts, mapAsked } = await start($, on, { manifestAfterShow: compiled, files: { 'target/manifest.json': JSON.stringify(MANIFEST), 'target/.altimate-plugin/compiled/shop/models/orders.sql': 'select * from main.stg_orders' }, mapRelations })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  // The compiled SQL and the manifest dbt show just wrote.
  expect(mapAsked).toEqual([{ sql: 'select * from main.stg_orders', manifest_path: `${ROOT}/target/.altimate-plugin/manifest.json` }])
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain("- hardcoded main.stg_orders: use {{ ref('stg_orders') }}. dbt does not know this model reads it")
  expect(note).toContain('Put the ref() or source() back unless the user asked for the table by name, and tell the user.')
  expect(toasts).toContain('⚠ orders · compiled and validated against the warehouse')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /hardcoded main\.stg_orders: use \{\{ ref\('stg_orders'\) \}\} — lineage can't follow it/ })).toBeDefined()
  await band.unmount()
})

test('a table an ephemeral parent reads (inlined into the compiled SQL) is read through refs; one past a materialized parent is hardcoded', async ($, on) => {
  // orders refs stg_orders, which reads raw_orders. Ephemeral, dbt inlines it, so the compiled SQL names raw_orders.
  const mapRelations = [{ raw: '"shop"."main"."raw_orders"', match: 'exact', candidates: [{ uniqueId: 'seed.shop.raw_orders', replaceWith: "{{ ref('raw_orders') }}", match: 'exact' }] }]
  const withStg = (materialized: string) => ({ ...MANIFEST, nodes: { ...MANIFEST.nodes, 'model.shop.stg_orders': { ...(MANIFEST.nodes as any)['model.shop.stg_orders'], config: { materialized } } } })
  const compiledSql = { 'target/.altimate-plugin/compiled/shop/models/orders.sql': 'with __dbt__cte__stg_orders as (select * from "shop"."main"."raw_orders") select * from __dbt__cte__stg_orders' }
  const { clock } = await start($, on, { manifestAfterShow: withStg('ephemeral'), files: { 'target/manifest.json': JSON.stringify(withStg('ephemeral')), ...compiledSql }, mapRelations })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  expect(result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).not.toContain('hardcoded')
})

test('a table read past a materialized parent (a view) is hardcoded, though it is upstream', async ($, on) => {
  const mapRelations = [{ raw: 'main.raw_orders', match: 'partial', candidates: [{ uniqueId: 'seed.shop.raw_orders', replaceWith: "{{ ref('raw_orders') }}", match: 'partial' }] }]
  const { clock } = await start($, on, { files: { 'target/.altimate-plugin/compiled/shop/models/orders.sql': 'select * from "shop"."main"."stg_orders" join main.raw_orders using (id)' }, mapRelations })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  expect(result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toContain("- hardcoded main.raw_orders: use {{ ref('raw_orders') }}")
})

test('an ephemeral model has no built relation to compare with: its undocumented columns are the edit\'s, and nothing is asked', async ($, on) => {
  const ephemeral = { ...MANIFEST, nodes: { ...MANIFEST.nodes, 'model.shop.orders': { ...(MANIFEST.nodes as any)['model.shop.orders'], config: { materialized: 'ephemeral' } } } }
  const { clock, runs } = await start($, on, { show: { rows: [{ order_id: 1, amount: 10, status: 'placed' }] }, built: () => [{ order_id: 1, amount: 10, status: 'placed' }], files: { 'target/manifest.json': JSON.stringify(ephemeral) } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  expect(runs.some(argv => argv.includes('--inline'))).toBe(false)
  expect(result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toContain('- returned but not documented in schema.yml: status')
})

test('a table read through ref() (a dependency), the model itself, or an unclear match is never flagged; without the tool, nothing is', async ($, on) => {

  const mapRelations = [
    { raw: '"shop"."main"."stg_orders"', match: 'exact', candidates: [{ uniqueId: 'model.shop.stg_orders', replaceWith: "{{ ref('stg_orders') }}", match: 'exact' }] },
    { raw: 'orders', match: 'exact', candidates: [{ uniqueId: 'model.shop.orders', replaceWith: "{{ ref('orders') }}", match: 'exact' }] },
    { raw: 'revenue', match: 'partial', candidates: [{ uniqueId: 'model.shop.revenue', replaceWith: "{{ ref('revenue') }}" }, { uniqueId: 'seed.shop.raw_orders', replaceWith: "{{ ref('raw_orders') }}" }] },
  ]
  const { clock } = await start($, on, { files: { 'target/.altimate-plugin/compiled/shop/models/orders.sql': 'select * from "shop"."main"."stg_orders", orders, revenue' }, mapRelations })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  expect(result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).not.toContain('hardcoded')
})

test('with an altimate-code that has no dbt_map_relations, nothing is flagged and the check goes on', async ($, on) => {
  const compiled = { ...MANIFEST, parent_map: { ...(MANIFEST as any).parent_map, 'model.shop.orders': [] }, nodes: { ...MANIFEST.nodes, 'model.shop.orders': { ...(MANIFEST.nodes as any)['model.shop.orders'], depends_on: { nodes: [] } } } }
  const { clock, mapAsked } = await start($, on, { manifestAfterShow: compiled, files: { 'target/manifest.json': JSON.stringify(MANIFEST), 'target/.altimate-plugin/compiled/shop/models/orders.sql': 'select * from main.stg_orders' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  expect(mapAsked).toEqual([])
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('compiled and ran')
  expect(note).not.toContain('hardcoded')
})

test('a dbt command that only rewrites the manifest starts no check; a change to the model\'s schema.yml checks it again', async ($, on) => {
  const { clock, runs, mtimes, setBash } = await start($, on, { show: { rows: [{ order_id: 1, order_total: 10 }] } })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'as amount', new_string: 'as order_total' })
  await clock.settle()
  const shows = () => runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline'))).toEqual([])
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
  // The band stays after Explain: Fix is still there, until a passing run or Dismiss clears it.
  expect(await band.find({ key: 'dbt-fix' })).toBeDefined()
  await band.press({ key: 'dbt-fix' })
  await clock.settle()
  expect(prompts[1]!.startsWith('/altimate-code:altimate Fix the failing dbt node below')).toBe(true)
  expect(await band.find({ key: 'dbt-explain' })).toBeDefined()
  await band.press({ key: 'dbt-failure-dismiss' })
  await clock.settle()
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline'))).toEqual([[DBT, 'show', '--select', 'orders', '--indirect-selection', 'empty', '--limit', '50', '--output', 'json', '--log-format', 'json']])

  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 row · 2 columns .* · your query/ })).toBeDefined()
  await ui.press({ key: 'results-rerun' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(2)
  await ui.unmount()
})

test('the pane is titled Query results, opens wide, and Min / Default / Max resize it and are remembered', async ($, on) => {
  const { clock, sizes, store } = await start($, on, { stored: { 'pane-sizes': { 'altimate-results': 'bogus' } } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  // The default is the widest dock (a request the surface caps); a stored value that is no size is ignored.
  expect(sizes.filter(one => one.id === 'altimate-results').at(-1)).toEqual({ id: 'altimate-results', title: 'Query results', columns: 240, rows: 30 })

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

test('with the terminal width known, Default is the widest dock, Min a quarter and Max is taller; Default does not change when the width becomes known', async ($, on) => {
  const { clock, sizes, setBash } = await start($, on)
  setBash({ stdout: showLog([{ id: 1 }], 'orders') })
  const results = () => sizes.filter(one => one.id === 'altimate-results')
  // Claude's show before any width is known: a request wide enough that the surface caps it to the widest dock.
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders' })
  await clock.settle()
  expect(results().at(-1)).toMatchObject({ columns: 240, rows: 30 })
  // A command from a 200-column terminal makes the width known; the widest dock is 45% of it, as the cap says.
  await $.command.run({ command: 'dbt-show', args: 'orders', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.settle()
  expect(results().at(-1)).toMatchObject({ columns: 90, rows: 30 })
  // A second Claude show after that asks for the same widest dock, not a narrower one.
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders --limit 3' })
  await clock.settle()
  expect(results().at(-1)).toMatchObject({ columns: 90, rows: 30 })

  const terminal = { plugin: 'altimate-code', surface: 'terminal', viewport: { columns: 200, rows: 50, isFullscreen: true } } as const
  const ui = await $.ui.mount({ ...RESULTS, ...terminal })
  await ui.press({ key: 'results-size-max' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 90, rows: 60 })
  await ui.press({ key: 'results-size-min' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 50, rows: 14 })
  await ui.unmount()
})

test('a pane drawn on another surface does not change the recorded terminal width', async ($, on) => {
  const { clock, sizes } = await start($, on)
  await $.command.run({ command: 'dbt-show', args: 'orders', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.settle()
  // The desktop app reports the pane's own width.
  const desktop = await $.ui.mount({ ...RESULTS, plugin: 'altimate-code', surface: 'desktop', viewport: { columns: 50, rows: 30 } })
  await desktop.press({ key: 'results-size-max' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 90, rows: 60 })
  await desktop.unmount()
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
  const { clock } = await start($, on, { profileAnswer: said({ status: 'ok', profile: 'shop', target: 'prod', type: 'snowflake' }) })
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
  const { clock, runs } = await start($, on, {
    version: 'Core:\n  - installed: 1.11.6\n',
    env: { DBT_PROFILES_DIR: '/proj/conf' },
    files: { 'conf/profiles.yml': 'shop:\n  target: dev\n  outputs:\n    dev:\n      type: snowflake\n' },
    profileAnswer: said({ status: 'ok', profile: 'shop', target: 'dev', type: 'snowflake' }),
  })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'the profile uses snowflake, but no dbt adapter is installed beside dbt-core' })).toBeDefined()
  // The script is handed the project file and the profiles.yml dbt reads.
  expect(runs.find(argv => argv[2] === PROFILE_TYPE)?.slice(3)).toEqual(['/proj/dbt_project.yml', '/proj/conf/profiles.yml'])
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline'))).toEqual([])
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/transform/orders.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(1)
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(1)
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(1)
  const notes = results.map(one => (one.context ?? []).filter((note: string) => note.startsWith('Altimate compile-and-validate')).length)
  // Which of the two later edits is the newest depends on the order the other features let them through: one of them, never the first.
  expect(notes[0]).toBe(0)
  expect(notes[1] + notes[2]).toBe(1)
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(2)
})

test('an Edit of schema.yml checks the model again', async ($, on) => {
  const { clock, runs, mtimes } = await start($, on)
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  mtimes['models/schema.yml'] = 50_000
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/schema.yml`, old_string: 'amount', new_string: 'order_total' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(2)
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
  expect(runs.find(argv => argv[1] === 'show' && !argv.includes('--inline'))).toEqual([DBT, 'show', '-s', 'orders', '--limit', '5', '--output', 'json', '--log-format', 'json'])
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(1)
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
  const { clock } = await start($, on, { env: { DBT_PROFILES_DIR: '/proj/conf' }, files: { 'conf/profiles.yml': 'other:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n' }, profileAnswer: said({ status: 'no_profile' }) })
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(2)
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(1)
})

test('a file path with `..` in it is read as the plain path inside its project', async ($, on) => {
  const { clock, runs } = await start($, on)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/../models/orders.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.find(argv => argv[1] === 'show' && !argv.includes('--inline'))?.[3]).toBe('path:models/orders.sql,package:shop,orders')
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(2)
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(2)
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
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(2)
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
  expect(runs.find(argv => argv[1] === 'show' && !argv.includes('--inline'))?.[3]).toBe('path:models/legacy.sql,package:shop,orders')
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

test('a versioned model\'s first check, with no manifest yet, learns its name from dbt ls and shows it once', async ($, on) => {
  const manifest = { metadata: { project_name: 'shop' }, parent_map: {}, child_map: {}, nodes: { 'model.shop.orders': { name: 'orders', resource_type: 'model', package_name: 'shop', version: 1, original_file_path: 'models/legacy.sql', config: {}, columns: {}, depends_on: { nodes: [] } } } }
  const { clock, runs, toasts } = await start($, on, { manifestAfterShow: manifest, listed: ['orders'], files: { 'models/legacy.sql': 'select 1' }, show: { rows: [{ order_id: 1 }], node: 'orders', mustInclude: 'orders' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/legacy.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  // dbt ls (no query) gives the name; the model is shown once, with it.
  expect(runs.filter(argv => argv[1] === 'ls')).toEqual([[DBT, 'ls', '--select', 'path:models/legacy.sql,package:shop', '--resource-type', 'model', '--indirect-selection', 'empty', '--output', 'json', '--output-keys', 'name resource_type', '--log-format', 'text']])
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).map(argv => argv[3])).toEqual(['path:models/legacy.sql,package:shop,orders'])
  expect(toasts.some(one => one.startsWith('✖'))).toBe(false)
  expect((result.context ?? []).some((note: string) => note.includes('FAILED'))).toBe(false)
})

test('a check whose manifest holds an old name for the model asks again with the name dbt now has', async ($, on) => {
  const node = (name: string) => ({ name, resource_type: 'model', package_name: 'shop', version: 1, original_file_path: 'models/legacy.sql', config: {}, columns: {}, depends_on: { nodes: [] } })
  const manifest = (name: string) => ({ metadata: { project_name: 'shop' }, parent_map: {}, child_map: {}, nodes: { 'model.shop.orders': node(name) } })
  const { clock, runs, toasts } = await start($, on, { manifestAfterShow: manifest('orders'), files: { 'target/manifest.json': JSON.stringify(manifest('legacy_name')), 'models/legacy.sql': 'select 1' }, show: { rows: [{ order_id: 1 }], node: 'orders', mustInclude: 'orders' } })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/legacy.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).map(argv => argv[3])).toEqual(['path:models/legacy.sql,package:shop,legacy_name', 'path:models/legacy.sql,package:shop,orders'])
  expect(toasts.some(one => one.startsWith('✖'))).toBe(false)
})

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

test('a versioned model whose show prints nothing ends FAILED after one show, naming the model dbt now has', async ($, on) => {
  const manifest = { metadata: { project_name: 'shop' }, parent_map: {}, child_map: {}, nodes: { 'model.shop.orders': { name: 'orders', resource_type: 'model', package_name: 'shop', version: 1, original_file_path: 'models/legacy.sql', config: {}, columns: {}, depends_on: { nodes: [] } } } }
  const { clock, runs } = await start($, on, { manifestAfterShow: manifest, listed: ['orders'], files: { 'models/legacy.sql': 'select 1' }, show: { rows: [{ order_id: 1 }], node: 'orders', mustInclude: 'never_selected' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/legacy.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length).toBe(1)
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

const said = (answer: Record<string, string>) => ({ exitCode: 0, stdout: JSON.stringify(answer) })
const adapterCases: [string, { exitCode: number; stdout: string }, string][] = [
  ['the output the script selected names the adapter', said({ status: 'ok', profile: 'shop', target: 'dev', type: 'duckdb' }), 'duckdb 1.10.1'],
  ['an adapter that is not installed fails with the pip command', said({ status: 'ok', profile: 'shop', target: 'wh', type: 'snowflake' }), 'the profile uses snowflake, but only duckdb is installed'],
  ['a templated target the script could not settle', said({ status: 'template', profile: 'shop', target: "{{ var('t') }}" }), "the profile's target is set by a template, so which adapter it uses could not be told; installed: duckdb"],
  ['a target with no output fails', said({ status: 'no_output', profile: 'shop', target: 'prod' }), 'profile shop has no output named prod'],
  ['an output with no type names the missing key', said({ status: 'no_type', profile: 'shop', target: 'dev' }), 'output dev has no `type` key'],
]
for (const [name, answer, expected] of adapterCases) {
  test(`doctor adapter: ${name}`, async ($, on) => {
    const { clock } = await start($, on, { profileAnswer: answer })
    await $.command.run({ command: 'dbt-doctor', args: '' })
    await clock.settle()
    const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: expected })).toBeDefined()
    await ui.unmount()
  })
}

for (const [name, answer, fixShown] of [['a no-output answer is a failure with a fix', { status: 'no_output', profile: 'shop', target: 'prod' }, true], ['an untyped output is a failure with its own fix, not the missing-output one', { status: 'no_type', profile: 'shop', target: 'dev' }, false]] as const) {
  test(name, async ($, on) => {
    const { clock } = await start($, on, { profileAnswer: said(answer) })
    await $.command.run({ command: 'dbt-doctor', args: '' })
    await clock.settle()
    const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /add the output to profiles\.yml, or pick another target/ })) !== undefined).toBe(fixShown)
    await ui.unmount()
  })
}

for (const [name, answer, expected] of [
  ['a python that fails', { exitCode: 1, stdout: '' }, 'could not tell which adapter the profile uses (its profiles.yml could not be read here); installed: duckdb'],
  ['an answer that says error', { exitCode: 0, stdout: '{"status":"error"}' }, 'could not tell which adapter the profile uses (its profiles.yml could not be read here); installed: duckdb'],
  ['an answer that is not JSON', { exitCode: 0, stdout: 'Traceback' }, 'could not tell which adapter the profile uses (its profiles.yml could not be read here); installed: duckdb'],
  ['a type the profile names', { exitCode: 0, stdout: '{"status":"ok","type":"snowflake"}' }, 'the profile uses snowflake, but only duckdb is installed'],
  ['no profile', { exitCode: 0, stdout: '{"status":"no_profile"}' }, 'no profile found for this project; installed: duckdb'],
] as const) {
  test(`doctor adapter with the Python answering: ${name}`, async ($, on) => {
    const { clock } = await start($, on, { profileAnswer: answer })
    await $.command.run({ command: 'dbt-doctor', args: '' })
    await clock.settle()
    const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: expected })).toBeDefined()
    await ui.unmount()
  })
}

test('with dbt on PATH, the profile script runs under the interpreter dbt\'s launcher names, not python3', async ($, on) => {
  const { clock, runs } = await start($, on, { pathDbtPython: '/x/bin/python' })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const script = runs.find(argv => argv[2] === PROFILE_TYPE)
  expect(script?.[0]).toBe('/x/bin/python')
  expect(runs.some(argv => argv[0] === 'python3')).toBe(false)
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'duckdb' })).toBeDefined()
  await ui.unmount()
})

test('with a project .venv, the profile script runs under the .venv\'s python', async ($, on) => {
  const { clock, runs } = await start($, on)
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  expect(runs.find(argv => argv[2] === PROFILE_TYPE)?.[0]).toBe('/proj/.venv/bin/python')
})

test('a manifest slice for a PATH dbt runs under dbt\'s own interpreter too', async ($, on) => {
  const { clock, runs } = await start($, on, { pathDbtPython: '/x/bin/python', manifestSize: 9 * 1024 * 1024 })
  await $.tool.call({ tool: 'Read', file_path: ORDERS })
  await clock.settle()
  expect(runs.find(argv => argv[2] === MANIFEST_SLICE)?.[0]).toBe('/x/bin/python')
})

// The script is checked for what it relies on; run for real, it answers the fixtures (anchored output key,
// list merge, anchored profile and outputs keys, DBT_PROFILE, DBT_TARGET, `default`, env_var) as dbt does.
kitTest('the profile script parses YAML for real and follows dbt\'s selection', () => {
  // Neither script lets the project folder shadow a module: dropping the working directory is its first statement.
  const dropCwd = "import sys; sys.path = [p for p in sys.path if p not in ('', '.')]\n"
  expect(PROFILE_TYPE.startsWith(dropCwd)).toBe(true)
  expect(MANIFEST_SLICE.startsWith(dropCwd)).toBe(true)
  // A type given by a template is settled like the target: the plain env_var, else `template`.
  expect(PROFILE_TYPE).toMatch(/if '\{\{' in kind:\n    kind = settle\(kind\)\n    if not kind:\n        out\('template'/)
  expect(PROFILE_TYPE).toContain('yaml.safe_load')
  expect(PROFILE_TYPE).toContain("os.environ.get('DBT_PROFILE') or project.get('profile')")
  expect(PROFILE_TYPE).toContain("os.environ.get('DBT_TARGET') or profile.get('target') or 'default'")
  expect(PROFILE_TYPE).toContain('env_var')
  for (const status of ['no_profile', 'template', 'no_output', 'no_type', 'ok', 'error']) expect(PROFILE_TYPE).toContain(`'${status}'`)
  // No hand-rolled reading of the YAML.
  expect(PROFILE_TYPE).not.toMatch(/split\('\\n'\)|readlines/)
})

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

test('a run_results.json over 4 MiB gives its failures through the project\'s Python, and they reach Explain', async ($, on) => {
  const failed = { results: [{ unique_id: 'test.shop.not_null_orders_amount.106140f9fd', status: 'error', message: 'artifact message from python', failures: null }] }
  const { clock, runs, prompts, setBash } = await start($, on, { runResultsSize: 9 * 1024 * 1024, runFailures: { exitCode: 0, stdout: JSON.stringify(failed) } })
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  const run = runs.find(argv => argv[2] === RUN_FAILURES)
  expect(run).toEqual(['/proj/.venv/bin/python', '-c', RUN_FAILURES, '/proj/target/run_results.json'])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]).toContain('artifact message from python')
  expect(prompts[0]!.split('\n- ').length - 1).toBe(1)
  await band.unmount()
})

test('a run_results.json over 4 MiB that is older than the command is read through the Python once, before the command, for its invocation, and not again', async ($, on) => {
  const old = await start($, on, { runResultsSize: 9 * 1024 * 1024, runResultsAt: 10 })
  old.setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await old.clock.settle()
  expect(old.runs.filter(argv => argv[2] === RUN_FAILURES).length).toBe(1)
})

test('a run_results.json over 4 MiB the Python cannot give leaves the failures dbt printed', async ($, on) => {
  const { clock, runs, prompts, setBash } = await start($, on, { runResultsSize: 9 * 1024 * 1024, runFailures: { exitCode: 1, stdout: '' } })
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  expect(runs.some(argv => argv[2] === RUN_FAILURES)).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]).toContain('not_null_orders_amount')
  await band.unmount()
})

test('a manifest over 4 MiB that could not be sliced is not reported as "dbt has no model for this file"', async ($, on) => {
  const { clock } = await start($, on, { manifestSize: 9 * 1024 * 1024, sliceAnswer: { exitCode: 1, stdout: '' }, show: { node: 'none' }, files: { 'models/disabled.sql': 'select 1' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/disabled.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('- not checked: the manifest could not be read, so whether dbt has a model for this file is unknown')
  expect(note).not.toContain('dbt has no model for this file (disabled')
  expect(note).not.toContain('FAILED')
})

test('a manifest that could not be read is named as the reason the columns were not compared, when dbt show returned rows', async ($, on) => {
  const { clock } = await start($, on, { manifestSize: 9 * 1024 * 1024, sliceAnswer: { exitCode: 1, stdout: '' }, files: { 'models/orders.sql': 'select 1' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/orders.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  const note = result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))
  expect(note).toContain('the manifest could not be read, so the documented columns could not be read')
  expect(note).not.toContain('the manifest has no entry for this file')
})

for (const field of ['type', 'target'] as const) {
  test(`doctor adapter: a templated ${field} is named as the ${field}`, async ($, on) => {
    const { clock } = await start($, on, { profileAnswer: said({ status: 'template', profile: 'shop', target: 'dev', field }) })
    await $.command.run({ command: 'dbt-doctor', args: '' })
    await clock.settle()
    const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: `the profile's ${field} is set by a template, so which adapter it uses could not be told; installed: duckdb` })).toBeDefined()
    await ui.unmount()
  })
}

test('doctor adapter: an output with no type is a failure, and says which output', async ($, on) => {
  const { clock } = await start($, on, { profileAnswer: said({ status: 'no_type', profile: 'shop', target: 'dev' }) })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'output dev has no `type` key' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✖ Adapter/ })).toBeDefined()
  await ui.unmount()
})

kitTest('PROFILE_TYPE says which field a template left unsettled, and echoes no template text', () => {
  expect(PROFILE_TYPE).toContain("out('template', profile=shown, field='target')")
  expect(PROFILE_TYPE).toContain("out('template', profile=shown, field='type')")
})

test('Bookmark after Clear history puts the shown result back in the history, bookmarked', async ($, on) => {
  const { clock, store, setBash } = await start($, on)
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: '.venv/bin/dbt show -s orders --log-format json' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  await ui.press({ key: 'results-clear' })
  await clock.settle()
  expect(store.get('dbt-results-history')).toEqual([])
  await ui.press({ key: 'results-bookmark' })
  await clock.settle()
  const kept = store.get('dbt-results-history') as any[]
  expect(kept.map(one => [one.title, one.bookmarked])).toEqual([['orders', true]])
  expect(await ui.find({ type: 'Button', text: /★ Bookmarked/ })).toBeDefined()
  await ui.unmount()
})

test('a failed store read keeps the sizes already chosen: the next choice saves both panes', async ($, on) => {
  let failing = false
  const { clock, store } = await start($, on, { stored: { 'pane-sizes': { 'altimate-results': 'max', 'altimate-lineage': 'min' } }, storeGetFails: () => failing })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  // The next session reads the store again, and it fails.
  failing = true
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: false })
  await clock.settle()
  failing = false
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: /● Max/ })).toBeDefined()
  await ui.press({ key: 'results-size-default' })
  await clock.settle()
  expect(store.get('pane-sizes')).toEqual({ 'altimate-results': 'default', 'altimate-lineage': 'min' })
  await ui.unmount()
})

test('a failing store read still registers /lineage, and the saved sizes are read once for both halves', async ($, on) => {
  const { registered, storeGets } = await start($, on, { storeGetFails: () => true })
  expect(registered).toContain('lineage')
  expect(registered).toContain('dbt-show')
  expect(storeGets.filter(key => key === 'pane-sizes').length).toBe(1)
})

test('Re-run of a bookmarked /dbt-show query keeps one bookmark', async ($, on) => {
  const { clock, store } = await start($, on)
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  await ui.press({ key: 'results-bookmark' })
  await clock.settle()
  await ui.press({ key: 'results-rerun' })
  await clock.settle()
  const kept = store.get('dbt-results-history') as any[]
  expect(kept.map(one => [one.title, one.bookmarked])).toEqual([['orders', true]])
  expect((await ui.findAll({ type: 'Button', text: /^★ orders/ })).length).toBe(1)
  await ui.unmount()
})

test('a docked pane reports the transcript\'s width, which never sets the next dock; an inline pane reports the terminal\'s', async ($, on) => {
  const { clock, sizes } = await start($, on)
  await $.command.run({ command: 'dbt-show', args: 'orders', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.settle()
  const docked = await $.ui.mount({ ...RESULTS, surface: 'terminal', viewport: { columns: 110, rows: 50, isFullscreen: true } })
  await docked.press({ key: 'results-size-max' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 90, rows: 60 })
  await docked.press({ key: 'results-size-default' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 90 })
  await docked.unmount()
  // Opened again by a query finishing: still the widest dock, equal to Default.
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 90 })
  const inline = await $.ui.mount({ ...RESULTS, surface: 'terminal', props: { ...RESULTS.props, placement: 'inline' }, viewport: { columns: 100, rows: 50, isFullscreen: false } })
  await inline.unmount()
  // The inline drawing gave the terminal's width: the next dock is sized from it.
  const again = await $.ui.mount({ ...RESULTS, surface: 'terminal', viewport: { columns: 55, rows: 50, isFullscreen: true } })
  await again.press({ key: 'results-size-max' })
  await clock.settle()
  expect(sizes.at(-1)).toMatchObject({ columns: 45, rows: 60 })
  await again.unmount()
})

test('seated inline above the prompt, where Claude Code gives the pane the same height whatever it asks for, the pane has no Min / Default / Max that would do nothing, and says why', async ($, on) => {
  const { clock } = await start($, on)
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const inline = await $.ui.mount({ ...RESULTS, surface: 'terminal', props: { ...RESULTS.props, placement: 'inline' }, viewport: { columns: 100, rows: 42, isFullscreen: false } })
  for (const size of ['min', 'default', 'max']) expect(await inline.find({ type: 'Button', key: `results-size-${size}` })).toBeUndefined()
  expect(await inline.find({ type: 'Text', text: /Above the prompt the pane is as tall as Claude Code lets it be/ })).toBeDefined()
  await inline.unmount()
  // Docked, the three are there.
  const docked = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await docked.find({ type: 'Button', key: 'results-size-max' })).toBeDefined()
  await docked.unmount()
})

test('Max asks for the width Default asks for, Min for less, and the first open asks as Default does', async ($, on) => {
  const { clock, sizes } = await start($, on)
  await $.command.run({ command: 'dbt-show', args: 'orders', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.settle()
  const first = sizes.at(-1)!
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal', viewport: { columns: 110, rows: 50, isFullscreen: true } })
  const asked: Record<string, any> = {}
  for (const size of ['min', 'default', 'max']) {
    await ui.press({ key: `results-size-${size}` })
    await clock.settle()
    asked[size] = sizes.at(-1)
  }
  expect(asked.default.columns).toBe(first.columns)
  expect(asked.max.columns).toBe(asked.default.columns)
  expect(asked.max.rows).toBeGreaterThan(asked.default.rows)
  expect(asked.min.columns).toBeLessThan(asked.default.columns)
  await ui.unmount()
})

test('table rows are clipped to the pane, never wrapped, and a value that fits is not cut', async ($, on) => {
  const { clock } = await start($, on, { show: { rows: [{ customer_id: 1, first_order: '2018-01-01', most_recent_order: '2018-02-10', number_of_orders: 2, lifetime_value: 33, note: 'x' }] } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  for (const [bodyColumns, whole] of [[30, false], [69, true]] as const) {
    const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal', props: { ...RESULTS.props, bodyColumns } })
    const row = await ui.find({ type: 'Text', text: /^1\s+│/ })
    expect(row).toBeDefined()
    expect((row as any).props.wrap).toBe('truncate-end')
    expect(row!.text.includes('2018-01-01')).toBe(whole)
    await ui.unmount()
  }
})

// ─── Secrets in dbt output, selection, a missing dbt, stale artifacts, history size ─────────────────

// dbt 1.10+'s error for a profiles.yml it cannot read, as it prints it: the lines around the fault are quoted, a password line among them.
const PROFILES_ERR = [
  '[\u001b[31mERROR\u001b[0m]: Encountered an error:',
  'Runtime Error',
  '  ',
  '  dbt encountered an error while trying to read your profiles.yml file.',
  '  ',
  '  Runtime Error',
  '    Syntax error near line 7',
  '    ------------------------------',
  '    6  |       path: shop.duckdb',
  '    7  |       password: SENTINEL_PW: invalid',
  '    8  | ',
  '    Raw Error:',
  '    mapping values are not allowed in this context',
  '      in "<unicode string>", line 7, column 28',
].join('\n')
// `dbt debug` prints the same error with no heading and no file name.
const DEBUG_PROFILES_ERR = '06:45:41  [\u001b[31mERROR\u001b[0m]: Encountered an error:\nRuntime Error\n  Syntax error near line 7\n  ------------------------------\n  6  |       path: shop.duckdb\n  7  |       password: SENTINEL_PW: invalid\n  8  | \n  \n  Raw Error:\n  ------------------------------\n  mapping values are not allowed in this context\n    in "<unicode string>", line 7, column 28'
const PROFILES_FIXED = 'profiles.yml could not be parsed; run `dbt debug` yourself to see the error'

const editOrders = (a: any) => a.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
const noteOf = (result: any) => (result.context ?? []).find((one: string) => one.startsWith('Altimate compile-and-validate')) as string

test('a profiles.yml parse error in dbt\'s JSON log never carries its password line to the edit note, the check pane or the band', async ($, on) => {
  const { clock, toasts } = await start($, on, { show: { error: PROFILES_ERR } })
  const result: any = await editOrders($)
  await clock.settle()
  const note = noteOf(result)
  expect(note).toContain(PROFILES_FIXED)
  expect(note).not.toContain('SENTINEL_PW')
  // Not the model's own error: no call to fix the model, no call to build upstream ones.
  expect(note).not.toContain('Fix the model before going on')
  const pane = await $.ui.mount({ ...CHECK, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /profiles\.yml could not be parsed/ })).toBeDefined()
  await pane.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /profiles\.yml could not be parsed/ })).toBeDefined()
    await band.unmount()
  }
  expect(toasts.join('\n')).not.toContain('SENTINEL_PW')
})

test('the same error in dbt\'s plain text output is replaced too', async ($, on) => {
  const { clock } = await start($, on, { show: { raw: { exitCode: 2, stdout: '', stderr: stripped(PROFILES_ERR) } } })
  const result: any = await editOrders($)
  await clock.settle()
  expect(noteOf(result)).toContain(PROFILES_FIXED)
  expect(JSON.stringify(result)).not.toContain('SENTINEL_PW')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
  await band.unmount()
})

function stripped(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

test('the doctor\'s connection detail and the note sent with the first prompt never carry the password line of a profiles.yml dbt could not read', async ($, on) => {
  const { clock, prompts } = await start($, on, { debug: { exitCode: 2, stdout: DEBUG_PROFILES_ERR } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /profiles\.yml could not be parsed/ })).toBeDefined()
  await ui.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
  await band.unmount()
  await $.prompt.submit({ text: 'hello' })
  expect(prompts[0]).toContain(PROFILES_FIXED)
  expect(prompts[0]).not.toContain('SENTINEL_PW')
})

test('a failed dbt command with that error puts the fixed line, not the quoted file, in the band, Explain and Fix', async ($, on) => {
  const { clock, prompts, toasts, setBash } = await start($, on, { runResultsAt: 1, now: 900_000 })
  setBash({ stdout: `${HEADER}\n${PROFILES_ERR}`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /profiles\.yml could not be parsed/ })).toBeDefined()
  await band.press({ key: 'dbt-explain' })
  await band.press({ key: 'dbt-fix' })
  await clock.settle()
  expect(prompts.length).toBe(2)
  for (const prompt of prompts) {
    expect(prompt).toContain(PROFILES_FIXED)
    expect(prompt).not.toContain('SENTINEL_PW')
  }
  expect(toasts.join('\n')).not.toContain('SENTINEL_PW')
  await band.unmount()
})

test('the same error in run_results.json is replaced in Explain too', async ($, on) => {
  // The same through run_results.json.
  const results = { results: [{ unique_id: 'model.shop.orders', status: 'error', message: stripped(PROFILES_ERR) }] }
  const second = await start($, on, { files: { 'target/run_results.json': JSON.stringify(results) } })
  second.setBash({ stdout: `${HEADER}\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await second.clock.settle()
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await again.press({ key: 'dbt-explain' })
  await second.clock.settle()
  expect(second.prompts.at(-1)).toContain(PROFILES_FIXED)
  expect(second.prompts.at(-1)).not.toContain('SENTINEL_PW')
  await again.unmount()
})

test('/dbt-show with that error shows the fixed line in the results pane', async ($, on) => {
  const { clock } = await start($, on, { show: { error: PROFILES_ERR } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /profiles\.yml could not be parsed/ })).toBeDefined()
  await ui.unmount()
})

test('a target that is a mapping is not echoed: the doctor says the target is not a name', async ($, on) => {
  const { clock, prompts } = await start($, on, { profileAnswer: said({ status: 'no_target', profile: 'shop' }) })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'profile shop: the target is not a name' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✖ Adapter/ })).toBeDefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'hello' })
  expect(prompts[0]).toContain('FAIL Adapter: profile shop: the target is not a name')
})

test('a model path with whitespace is not checked: dbt would split the selection and run other models', async ($, on) => {
  const { clock, runs, toasts } = await start($, on, { files: { 'models/staging old/b.sql': 'select 1' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/staging old/b.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show' || argv[1] === 'ls')).toEqual([])
  const note = noteOf(result)
  expect(note).toContain("- not checked: the model's path has a space, which dbt's selector would split.")
  expect(note).not.toContain('FAILED')
  expect(toasts.some(one => one.includes("the model's path has a space"))).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /not checked: the model's path has a space/ })).toBeDefined()
  await band.unmount()
})

for (const how of ['spawn', 'not-found'] as const) {
  test(`when dbt cannot be run (${how}), an edit is "not checked", not FAILED, and later edits do not spawn it until the doctor finds it`, async ($, on) => {
    let missing: 'spawn' | 'not-found' | null = how
    const { clock, runs, toasts } = await start($, on, { dbtMissing: () => missing })
    const first: any = await editOrders($)
    await clock.settle()
    expect(noteOf(first)).toContain('- not checked: dbt could not be run here.')
    expect(noteOf(first)).not.toContain('FAILED')
    expect(toasts.some(one => one.startsWith('✖'))).toBe(false)
    const spawned = () => runs.filter(argv => argv[1] === 'show' || argv[1] === 'ls').length
    const afterFirst = spawned()
    expect(afterFirst).toBeGreaterThan(0)
    // The next edits start nothing.
    const second: any = await editOrders($)
    await editOrders($)
    await clock.settle()
    expect(spawned()).toBe(afterFirst)
    expect(noteOf(second)).toContain('dbt could not be run here')
    // The doctor finds dbt again: edits are checked once more.
    missing = null
    await $.command.run({ command: 'dbt-doctor', args: '' })
    await clock.settle()
    const third: any = await editOrders($)
    await clock.settle()
    expect(spawned()).toBeGreaterThan(afterFirst)
    expect(noteOf(third)).toContain('compiled and ran')
  })
}

test('a run_results.json whose invocation is the one seen before the command is not this command\'s, whatever its timestamp says', async ($, on) => {
  const withId = (id: string) => JSON.stringify({ ...RUN_RESULTS, metadata: { invocation_id: id, generated_at: '2026-11-17T00:00:00Z' } })
  const command = '\u001b[0m06:45:43  Compilation Error in model customers (models/customers.sql)\n  boom\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1'
  // The command wrote nothing: the file in the folder is an earlier run's, though its mtime is ahead of the command's start.
  const stale = await start($, on, { runResultsAt: 9_000_000, files: { 'target/run_results.json': withId('earlier-run') } })
  stale.setBash({ stdout: command, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s customers' })
  await stale.clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /customers/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /not_null_orders_amount/ })).toBeUndefined()
  await band.unmount()
})

test('a run_results.json with another invocation than the one seen before the command is read', async ($, on) => {
  const withId = (id: string) => JSON.stringify({ ...RUN_RESULTS, metadata: { invocation_id: id, generated_at: '2026-11-17T00:00:00Z' } })
  const command = '\u001b[0m06:45:43  Compilation Error in model customers (models/customers.sql)\n  boom\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1'
  // The command wrote its own: another invocation, read.
  let ctx: any
  ctx = await start($, on, { runResultsAt: 9_000_000, files: { 'target/run_results.json': withId('earlier-run') }, duringBash: async () => void (ctx.files['target/run_results.json'] = withId('this-run')) })
  ctx.setBash({ stdout: command, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s customers' })
  await ctx.clock.settle()
  const fresh = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await fresh.find({ type: 'Text', text: /not_null_orders_amount/ })).toBeDefined()
  await fresh.unmount()
})

test('a column documented with quote: true is compared exactly, any other without case', async ($, on) => {
  expect(columnDrift(['ID', 'Amount'], ['id', 'amount'], ['ID'])).toEqual({ missing: ['ID'], undocumented: ['id'] })
  expect(columnDrift(['ID'], ['ID'], ['ID'])).toEqual({ missing: [], undocumented: [] })
  expect(columnDrift(['ID'], ['id'])).toEqual({ missing: [], undocumented: [] })
  const manifest = JSON.parse(JSON.stringify(MANIFEST))
  manifest.nodes['model.shop.orders'].columns = { ID: { name: 'ID', quote: true }, amount: { name: 'amount', quote: false } }
  const { clock } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(manifest) }, show: { rows: [{ id: 1, AMOUNT: 10 }] } })
  const result: any = await editOrders($)
  await clock.settle()
  const note = noteOf(result)
  expect(note).toContain('- documented in schema.yml but not returned: ID')
  expect(note).toContain('- returned but not documented in schema.yml: id')
  expect(note).not.toContain('amount')
})

const savedQuery = (title: string, bookmarked: boolean, cell: unknown = 1) => ({ id: JSON.stringify([ROOT, title, null, []]), title, root: ROOT, select: title, inline: null, options: [], columns: ['a'], rows: [[cell]], limit: 50, ms: 1, at: 1, error: null, by: 'you', bookmarked })

test('a saved query keeps its long cells cut, and no more rows than its byte budget', async ($, on) => {
  const long = 'x'.repeat(5_000)
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, note: long, doc: { text: long } }))
  const { clock, store } = await start($, on, { show: { rows } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const [entry] = store.get('dbt-results-history') as any[]
  expect(entry.rows.length).toBeGreaterThan(0)
  for (const row of entry.rows) for (const cell of row.slice(1)) expect(String(cell).length).toBeLessThanOrEqual(200)
  expect(JSON.stringify(entry.rows).length).toBeLessThanOrEqual(32 * 1024)
  expect(entry.rows[0][1].endsWith('…')).toBe(true)
  expect(savedRows([[1, 'short']], 50)).toEqual([[1, 'short']])
})

test('bookmarks are capped at 50: the newest keep their rows, an older one is plain history again', async ($, on) => {
  const marked = Array.from({ length: 50 }, (_, i) => savedQuery(`kept${i}`, true))
  const { clock, store } = await start($, on, { stored: { 'dbt-results-history': marked } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  await ui.press({ key: 'results-bookmark' })
  await clock.settle()
  const history = store.get('dbt-results-history') as any[]
  expect(history.filter(one => one.bookmarked).length).toBe(50)
  expect(history.find(one => one.title === 'orders')?.bookmarked).toBe(true)
  // The oldest bookmark gave way: it is a plain entry now.
  expect(history.find(one => one.title === 'kept49')?.bookmarked).toBeFalsy()
  await ui.unmount()
})

test('a refused history write drops the oldest plain entries and tries once more; bookmarks and pane sizes are kept', async ($, on) => {
  const cell = 'y'.repeat(150)
  const plain = Array.from({ length: 16 }, (_, i) => savedQuery(`plain${i}`, false, cell))
  const mark = savedQuery('marked', true, cell)
  const bytes = (list: unknown[]) => JSON.stringify(list).length
  // Room for what is stored and a little more: one more query does not fit until older ones go.
  const { clock, store } = await start($, on, { stored: { 'dbt-results-history': [...plain, mark] }, storeLimit: bytes([...plain, mark]) + 100 })
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  await ui.press({ key: 'results-size-max' })
  await clock.settle()
  expect((store.get('pane-sizes') as any)['altimate-results']).toBe('max')
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const history = store.get('dbt-results-history') as any[]
  expect(history.some(one => one.title === 'orders')).toBe(true)
  expect(history.some(one => one.title === 'marked' && one.bookmarked)).toBe(true)
  expect(history.length).toBeLessThan(18)
  // The sizes were written too, and a later choice still saves.
  await ui.press({ key: 'results-size-min' })
  await clock.settle()
  expect((store.get('pane-sizes') as any)['altimate-results']).toBe('min')
  await ui.unmount()
})

test('a /dbt-show queued before a /clear is kept in the history but does not fill the new conversation\'s pane', async ($, on) => {
  let release!: () => void
  const { clock, opened, store } = await start($, on, { holdShow: new Promise<void>(go => (release = go)) })
  const shown = $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  await $.session.end({ reason: 'clear' } as any)
  // The press opened the pane itself; the query that finishes after the /clear opens nothing more.
  const before = opened.length
  release()
  await shown
  await clock.settle()
  expect(opened.length).toBe(before)
  expect((store.get('dbt-results-history') as any[]).map(one => one.title)).toEqual(['orders'])
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 row/ })).toBeUndefined()
  await ui.unmount()
})

test('an error that is not the model\'s own (a parent not built, a connection) does not tell Claude to fix the model or build upstream', async ($, on) => {
  const { clock } = await start($, on, { show: { error: 'Runtime Error in model orders (models/orders.sql)\n  Catalog Error: Table with name stg_orders does not exist!' } })
  const result: any = await editOrders($)
  await clock.settle()
  const note = noteOf(result)
  expect(note).toContain('Catalog Error: Table with name stg_orders does not exist!')
  expect(note).not.toContain('Fix the model before going on')
  expect(note).toContain("This may not be the model's fault (a parent may not be built yet")
  expect(note).toContain("don't build upstream models on the warehouse to check")
})

test('an error in the model\'s own SQL still tells Claude to fix the model', async ($, on) => {
  const { clock } = await start($, on, { show: { error: 'Binder Error: Referenced column "order_dte" not found in FROM clause!' } })
  const result: any = await editOrders($)
  await clock.settle()
  expect(noteOf(result)).toContain('Fix the model before going on')
})

// dbt 1.10+ with DBT_LOG_FORMAT=json: the same error as a JSON record, its line breaks escaped in the raw output.
const JSON_PROFILES_ERR = JSON.stringify({ info: { level: 'error', code: 'Z002', msg: 'Runtime Error\n  Syntax error near line 7\n  7  | password: SENTINEL_PW: invalid' }, data: {} })

test('a JSON-format profiles.yml error from dbt debug never reaches the doctor, the band or the note, and the plugin asks for text', async ($, on) => {
  const { clock, runs, prompts } = await start($, on, { debug: { exitCode: 2, stdout: JSON_PROFILES_ERR } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  expect(runs.find(argv => argv[1] === 'debug')).toEqual([DBT, 'debug', '--log-format', 'text'])
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /profiles\.yml could not be parsed/ })).toBeDefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'hello' })
  expect(prompts[0]).toContain(PROFILES_FIXED)
  expect(prompts[0]).not.toContain('SENTINEL_PW')
})

test('the same JSON record in an edit check is replaced in the note, the pane and the band', async ($, on) => {
  const { clock } = await start($, on, { show: { raw: { exitCode: 2, stdout: JSON_PROFILES_ERR } } })
  const result: any = await editOrders($)
  await clock.settle()
  expect(noteOf(result)).toContain(PROFILES_FIXED)
  expect(JSON.stringify(result)).not.toContain('SENTINEL_PW')
  const pane = await $.ui.mount({ ...CHECK, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /SENTINEL_PW/ })).toBeUndefined()
  await band.unmount()
  // A syntax error in another YAML file is not the profiles.yml one: it keeps its own text.
  expect(profilesError('Runtime Error\n  Syntax error near line 3\n  3  | x: y: z\n  in models/schema.yml')).toBe(false)
})

test('dbt ls lists the model and its test: only the model gives the name, so the model is shown by it', async ($, on) => {
  const manifest = { metadata: { project_name: 'shop' }, parent_map: {}, child_map: {}, nodes: {} }
  const { clock, runs } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(manifest), 'models/legacy.sql': 'select 1' }, listed: [{ name: 'orders', resource_type: 'model' }, { name: 'not_null_orders_id', resource_type: 'test' }], show: { rows: [{ order_id: 1 }], node: 'orders', mustInclude: 'orders' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/legacy.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).map(argv => argv[3])).toEqual(['path:models/legacy.sql,package:shop,orders'])
  expect((result.context ?? []).join('\n')).not.toContain('FAILED')
})

test('a /dbt-show asked before a /clear but started after it stays out of the new conversation\'s pane', async ($, on) => {
  const { clock, opened, store } = await start($, on)
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await $.session.end({ reason: 'clear' } as any)
  const before = opened.length
  await clock.settle()
  expect(opened.length).toBe(before)
  expect((store.get('dbt-results-history') as any[]).map(one => one.title)).toEqual(['orders'])
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 row/ })).toBeUndefined()
  await ui.unmount()
})

kitTest('a saved query is held to its serialized size as a whole: rows go until it fits, and its error is cut', () => {
  const entry = { columns: Array.from({ length: 100 }, (_, i) => `c${i}`.padEnd(100, 'x')), rows: Array.from({ length: 300 }, () => ['y'.repeat(190)]), error: 'e'.repeat(10_000) }
  const fit = fitSaved(entry)
  expect(JSON.stringify(fit).length).toBeLessThanOrEqual(32 * 1024)
  expect(fit.rows.length).toBeGreaterThan(0)
  expect(fit.rows.length).toBeLessThan(entry.rows.length)
  expect(fit.error!.length).toBe(2000)
  expect(fitSaved({ columns: ['a'], rows: [[1]], error: null })).toEqual({ columns: ['a'], rows: [[1]], error: null })
})

test('a run that exited 0 whose rows say "command not found" does not make dbt unrunnable', async ($, on) => {
  const { clock, runs } = await start($, on, { show: { rows: [{ msg: 'command not found' }] } })
  await editOrders($)
  await clock.settle()
  const shows = () => runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length
  expect(shows()).toBe(1)
  await editOrders($)
  await clock.settle()
  expect(shows()).toBe(2)
})

test('a dbt deps that fails because git is not found does not make dbt unrunnable', async ($, on) => {
  const { clock, runs } = await start($, on, { interactive: true, files: { 'packages.yml': 'packages: []' }, depsFails: 'sh: git: command not found', depsExit: 127 })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-doctor-deps' })
  await clock.settle()
  await band.unmount()
  const result: any = await editOrders($)
  await clock.settle()
  expect(runs.some(argv => argv[1] === 'show' && !argv.includes('--inline'))).toBe(true)
  expect(noteOf(result)).not.toContain('dbt could not be run here')
})

test('dbt ls that fails, a first show with no preview and a fresh manifest that names the model: one re-show with its name, and no FAILED', async ($, on) => {
  const manifest = { metadata: { project_name: 'shop' }, parent_map: {}, child_map: {}, nodes: { 'model.shop.orders': { name: 'orders', resource_type: 'model', package_name: 'shop', version: 1, original_file_path: 'models/legacy.sql', config: {}, columns: {}, depends_on: { nodes: [] } } } }
  const { clock, runs, toasts } = await start($, on, { listFails: true, manifestAfterShow: manifest, files: { 'models/legacy.sql': 'select 1' }, show: { rows: [{ order_id: 1 }], node: 'orders', mustInclude: 'orders' } })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/legacy.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).map(argv => argv[3])).toEqual(['path:models/legacy.sql,package:shop', 'path:models/legacy.sql,package:shop,orders'])
  expect(toasts.some(one => one.startsWith('✖'))).toBe(false)
  expect((result.context ?? []).join('\n')).not.toContain('FAILED')
})

kitTest('a saved query is measured in UTF-8 bytes; with no rows left its columns are dropped, and its inline SQL is never cut', () => {
  // 190 three-byte characters a row: 570 bytes, though 190 UTF-16 units.
  const wide = { columns: ['a'], rows: Array.from({ length: 300 }, () => ['日'.repeat(190)]), error: null }
  const rows = savedRows(wide.rows, 300)
  expect(new TextEncoder().encode(JSON.stringify(rows)).length).toBeLessThanOrEqual(32 * 1024)
  const fit = fitSaved({ ...wide, rows })
  expect(new TextEncoder().encode(JSON.stringify(fit)).length).toBeLessThanOrEqual(32 * 1024)
  const big = fitSaved({ columns: Array.from({ length: 2000 }, (_, i) => `col${i}`.padEnd(40, 'x')), rows: [], error: null, inline: 'q'.repeat(40_000) })
  expect(big.inline).toBe('q'.repeat(40_000))
  // The inline SQL alone is over the cap: dropping columns would not cure it, so they stay.
  expect(big.columns.length).toBe(2000)
  const small = fitSaved({ columns: Array.from({ length: 2000 }, (_, i) => `col${i}`.padEnd(40, 'x')), rows: [], error: null, inline: 'select 1' })
  expect(small.inline).toBe('select 1')
  expect(small.columns.length).toBeGreaterThan(0)
  expect(new TextEncoder().encode(JSON.stringify(small)).length).toBeLessThanOrEqual(32 * 1024)
})

kitTest('the history is held to its total budget: the oldest unbookmarked entries go first, then the oldest bookmarks', () => {
  const entry = (title: string, bookmarked: boolean) => ({ title, bookmarked, rows: [['z'.repeat(30_000)]] })
  const history = [...Array.from({ length: 20 }, (_, i) => entry(`plain${i}`, false)), ...Array.from({ length: 50 }, (_, i) => entry(`mark${i}`, true))]
  const fit = budgetHistory(history)
  expect(new TextEncoder().encode(JSON.stringify(fit)).length).toBeLessThanOrEqual(2 * 1024 * 1024)
  // Every bookmark stays while unbookmarked ones remain to drop; the oldest unbookmarked went.
  expect(fit.filter(one => one.bookmarked).length).toBe(50)
  expect(fit.some(one => one.title === 'plain19')).toBe(false)
  expect(fit.some(one => one.title === 'plain0')).toBe(true)
  // With bookmarks alone over the budget, the oldest bookmarks go.
  const only = budgetHistory(Array.from({ length: 80 }, (_, i) => entry(`m${i}`, true)))
  expect(only.length).toBeLessThan(80)
  expect(only[0]!.title).toBe('m0')
  expect(only.some(one => one.title === 'm79')).toBe(false)
  expect(dropOldest([entry('a', false), entry('b', true), entry('c', false)], 1).map(one => one.title)).toEqual(['a', 'b'])
  expect(dropOldest([entry('a', false), entry('b', true), entry('c', false)], 3).map(one => one.title)).toEqual([])
})

test('a refused write that dropping unbookmarked entries cannot cure drops the oldest bookmarks too', async ($, on) => {
  const marked = Array.from({ length: 8 }, (_, i) => savedQuery(`mark${i}`, true, 'y'.repeat(150)))
  const bytes = JSON.stringify(marked).length
  const { clock, store } = await start($, on, { stored: { 'dbt-results-history': marked }, storeLimit: Math.floor(bytes * 0.7) })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const history = store.get('dbt-results-history') as any[]
  expect(JSON.stringify(history).length).toBeLessThanOrEqual(Math.floor(bytes * 0.7))
  expect(history.length).toBeLessThan(9)
  // The newest bookmarks stay.
  expect(history.some(one => one.title === 'mark0')).toBe(true)
  expect(history.some(one => one.title === 'mark7')).toBe(false)
})

test('a dbt deps that fails because git is not found, as dash and busybox say it, does not make dbt unrunnable', async ($, on) => {
  const { clock, runs } = await start($, on, { interactive: true, files: { 'packages.yml': 'packages: []' }, depsFails: 'sh: 1: git: not found', depsExit: 127 })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-doctor-deps' })
  await clock.settle()
  await band.unmount()
  const result: any = await editOrders($)
  await clock.settle()
  expect(runs.some(argv => argv[1] === 'show' && !argv.includes('--inline'))).toBe(true)
  expect(noteOf(result)).not.toContain('dbt could not be run here')
})

test('a bare exit 127 that says something is not found does not make dbt unrunnable', async ($, on) => {
  const { clock, runs } = await start($, on, { interactive: true, files: { 'packages.yml': 'packages: []' }, depsFails: 'could not exec helper: not found', depsExit: 127 })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-doctor-deps' })
  await clock.settle()
  await band.unmount()
  const result: any = await editOrders($)
  await clock.settle()
  expect(runs.some(argv => argv[1] === 'show' && !argv.includes('--inline'))).toBe(true)
  expect(noteOf(result)).not.toContain('dbt could not be run here')
})

kitTest('a query whose uncuttable fields are over the cap keeps its rows and columns', () => {
  const inline = 'q'.repeat(40_000)
  const entry = { id: JSON.stringify(['/proj', null, inline, []]), inline, columns: ['a', 'b'], rows: [[1, 2], [3, 4]], error: null }
  const fit = fitSaved(entry)
  expect(fit.rows).toEqual(entry.rows)
  expect(fit.columns).toEqual(['a', 'b'])
  expect(fit.inline).toBe(inline)
})

// ─── dbt's errors about the profile quote its values: none of them reaches a surface ─────────────

const PROFILE_SHAPES: [string, string, string][] = [
  ['an unquoted all-digit password', 'Runtime Error\n  Credentials in profile "shop", target "dev" invalid: 9912345 is not of type \'string\'\n', '9912345'],
  ['a keyfile_json given as a string', 'Runtime Error\n  Credentials in profile "shop", target "dev" invalid: \'{"type": "service_account", "private_key": "SENTINEL_KEY"}\' is not valid under any of the given schemas\n', 'SENTINEL_KEY'],
  ['a password written as a list', 'Runtime Error\n  Credentials in profile "shop", target "dev" invalid: [\'SENTINEL_LIST\'] is not valid under any of the given schemas\n', 'SENTINEL_LIST'],
  ['a template that does not render', 'Compilation Error\n  Could not render {{ env_var(\'X\', \'SENTINEL_TPL\') | bad_filter }}\n', 'SENTINEL_TPL'],
  ['a quoted line that itself names a .yml', 'Runtime Error\n  Syntax error near line 7\n  ------------------------------\n  6  |       path: shop.duckdb\n  7  |       password: SENTINEL_YML.yml: invalid\n  8  | \n  \n  Raw Error:\n  mapping values are not allowed in this context\n', 'SENTINEL_YML'],
]

for (const [shape, text, secret] of PROFILE_SHAPES) {
  test(`dbt's error for ${shape} never reaches the edit note, the check pane, the band, Explain or Fix, /dbt-show, its history or the doctor`, async ($, on) => {
    // An edit's check.
    const check = await start($, on, { show: { raw: { exitCode: 2, stdout: text } } })
    const result: any = await editOrders($)
    await check.clock.settle()
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(noteOf(result)).toContain(PROFILES_FIXED)
    const pane = await $.ui.mount({ ...CHECK, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    await pane.unmount()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    await band.unmount()
    // /dbt-show: the pane and the saved history.
    await $.command.run({ command: 'dbt-show', args: 'orders' })
    await check.clock.settle()
    const results = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
    expect(await results.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    expect(await results.find({ type: 'Text', text: /profiles\.yml could not be parsed/ })).toBeDefined()
    await results.unmount()
    expect(JSON.stringify(check.store.get('dbt-results-history'))).not.toContain(secret)
    expect(check.toasts.join('\n')).not.toContain(secret)
  })

  test(`dbt's error for ${shape} in Claude's own failed dbt command never reaches the band, Explain or Fix`, async ($, on) => {
    const { clock, prompts, setBash } = await start($, on, { runResultsAt: 1, now: 900_000 })
    setBash({ stdout: `${HEADER}\n${text}`, isError: true })
    await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
    await clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    await band.press({ key: 'dbt-explain' })
    await band.press({ key: 'dbt-fix' })
    await clock.settle()
    expect(prompts.length).toBe(2)
    for (const prompt of prompts) expect(prompt).not.toContain(secret)
    await band.unmount()
  })

  test(`dbt's error for ${shape} in dbt debug never reaches the doctor's detail or the note sent with the next prompt`, async ($, on) => {
    const { clock, prompts } = await start($, on, { debug: { exitCode: 2, stdout: `06:45:41  Profile loading failed:\n${text}` } })
    await $.command.run({ command: 'dbt-doctor', args: '' })
    await clock.settle()
    const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    await ui.unmount()
    await $.prompt.submit({ text: 'hello' })
    expect(prompts[0]).not.toContain(secret)
    expect(debugInfo(`Profile loading failed:\n${text}`).detail).not.toContain(secret)
  })

  kitTest(`the helpers replace dbt's error for ${shape} whole`, () => {
    for (const out of [text, errorLog(text)]) {
      expect(profilesError(out)).toBe(true)
      expect(logErrors(errorLog(text)).join('\n')).not.toContain(secret)
      expect(JSON.stringify(failuresFromText(out))).not.toContain(secret)
    }
  })
}

kitTest('a syntax error in another YAML file, and the doctor\'s status lines for profiles.yml, are not profile errors', () => {
  expect(profilesError('Runtime Error\n  Syntax error near line 3\n  3  | x: y.yml: z\n  in models/schema.yml')).toBe(false)
  expect(profilesError('06:45:45  Using profiles.yml file at /home/me/.dbt/profiles.yml\n06:45:45    profiles.yml file [OK found and valid]\n06:45:45    Connection test: [ERROR]\n  could not connect to server')).toBe(false)
})

// ─── Review follow-ups: invocation ids, wrappers, history, the pane's names ──────────────────────

const withInvocation = (id: string) => JSON.stringify({ ...RUN_RESULTS, metadata: { invocation_id: id, generated_at: '2026-11-17T00:00:00Z' } })
const CUSTOMERS_FAILED = '\u001b[0m06:45:43  Compilation Error in model customers (models/customers.sql)\n  boom\nDone. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 TOTAL=1'

test('a run_results.json over 4 MiB that is the one seen before the command is not this command\'s', async ($, on) => {
  const earlier = JSON.stringify({ results: [{ unique_id: 'test.shop.not_null_orders_amount.106140f9fd', status: 'error', message: 'old failure' }], metadata: { invocation_id: 'earlier-run', generated_at: 'x' } })
  const { clock, setBash } = await start($, on, { runResultsSize: 9 * 1024 * 1024, runResultsAt: 9_000_000, runFailures: { exitCode: 0, stdout: earlier } })
  setBash({ stdout: CUSTOMERS_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s customers' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /customers/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /not_null_orders_amount/ })).toBeUndefined()
  await band.unmount()
})

test('the plugin\'s own dbt show, run while Claude\'s command runs, writes its run results to its own folder: the project\'s are left to Claude\'s command', async ($, on) => {
  let ctx: any
  ctx = await start($, on, {
    runResultsAt: 9_000_000,
    show: { rows: [{ order_id: 1 }], writes: 'plugin-show' },
    // The plugin's check finishes while Claude's command is running.
    duringBash: async () => {
      await editOrders($)
      await ctx.clock.settle()
    },
  })
  const projectResults = ctx.files['target/run_results.json']
  ctx.setBash({ stdout: CUSTOMERS_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s customers' })
  await ctx.clock.settle()
  expect(ctx.files['target/run_results.json']).toBe(projectResults)
  expect(ctx.files['target/.altimate-plugin/run_results.json']).toContain('plugin-show')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /customers/ })).toBeDefined()
  await band.unmount()
})

test('Claude\'s run that wrote run_results.json after the plugin\'s own dbt show, before the plugin read it, is still recorded', async ($, on) => {
  let ctx: any
  // The plugin's dbt printed its own id; by the time the process exited Claude's run had written the file.
  ctx = await start($, on, {
    runResultsAt: 9_000_000,
    show: { rows: [{ order_id: 1 }], claudeWrites: 'claude-run', invocation: 'plugin-show' },
    duringBash: async () => {
      await editOrders($)
      await ctx.clock.settle()
    },
  })
  ctx.setBash({ stdout: CUSTOMERS_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt run -s customers' })
  await ctx.clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /not_null_orders_amount/ })).toBeDefined()
  await band.unmount()
})

const WRAPPERS: [string, number, string][] = [
  ['a bad interpreter', 126, 'bash: /proj/.venv/bin/dbt: /gone/bin/python: bad interpreter: No such file or directory'],
  ['a shebang whose file is not found', 127, 'sh: /proj/.venv/bin/dbt: cannot execute: required file not found'],
  ['Windows saying dbt is not recognized', 1, "'dbt' is not recognized as an internal or external command,\noperable program or batch file."],
]
for (const [what, exitCode, stderr] of WRAPPERS) {
  test(`${what} is dbt that cannot be run: not checked, not FAILED, and not spawned again`, async ($, on) => {
    const { clock, runs } = await start($, on, { show: { raw: { exitCode, stdout: '', stderr } } })
    const first: any = await editOrders($)
    await clock.settle()
    expect(noteOf(first)).toContain('- not checked: dbt could not be run here.')
    expect(noteOf(first)).not.toContain('FAILED')
    const shows = () => runs.filter(argv => argv[1] === 'show' && !argv.includes('--inline')).length
    const after = shows()
    await editOrders($)
    await clock.settle()
    expect(shows()).toBe(after)
  })
}

test('the same words with exit 0 do not make dbt unrunnable', async ($, on) => {
  const { clock } = await start($, on, { show: { raw: { exitCode: 0, stdout: 'bad interpreter', stderr: 'dbt: cannot execute: required file not found' } } })
  const note: any = await editOrders($)
  await clock.settle()
  expect(noteOf(note)).not.toContain('dbt could not be run here')
})

test('a bad interpreter of another program does not make dbt unrunnable', async ($, on) => {
  const { clock } = await start($, on, { show: { raw: { exitCode: 126, stdout: '', stderr: 'bash: ./hook.sh: /bin/sh^M: bad interpreter: No such file or directory' } } })
  const note: any = await editOrders($)
  await clock.settle()
  expect(noteOf(note)).not.toContain('dbt could not be run here')
})

test('a history write that fails twice is logged', async ($, on) => {
  const marked = Array.from({ length: 8 }, (_, i) => savedQuery(`mark${i}`, true, 'y'.repeat(150)))
  const logs: string[] = []
  const ctx = await start($, on, { stored: { 'dbt-results-history': marked }, storeLimit: 10, logs })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await ctx.clock.settle()
  expect(logs.some(one => one.includes('query history could not be saved'))).toBe(true)
})

test('the pane drops from view what the store dropped', async ($, on) => {
  const marked = Array.from({ length: 8 }, (_, i) => savedQuery(`mark${i}`, true, 'y'.repeat(150)))
  const bytes = JSON.stringify(marked).length
  const { clock, store } = await start($, on, { stored: { 'dbt-results-history': marked }, storeLimit: Math.floor(bytes * 0.7) })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const kept = (store.get('dbt-results-history') as any[]).map(one => one.title)
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(kept.includes('mark7')).toBe(false)
  expect(kept.includes('mark0')).toBe(true)
  expect(await ui.find({ type: 'Button', text: /mark0/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /mark7/ })).toBeUndefined()
  await ui.unmount()
})

test('the check pane marks only the column the core found undocumented: a quoted ID returned beside id', async ($, on) => {
  const manifest = JSON.parse(JSON.stringify(MANIFEST))
  manifest.nodes['model.shop.orders'].columns = { ID: { name: 'ID', quote: true } }
  const { clock } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(manifest) }, show: { rows: [{ ID: 1, id: 2 }] } })
  await editOrders($)
  await clock.settle()
  const pane = await $.ui.mount({ ...CHECK, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /^\+ id\s+returned, not documented/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^✓ ID\s*$/ })).toBeDefined()
  await pane.unmount()
})

test('/dbt-show captures its generation at entry: a /clear during its first await opens no pane and keeps its rows out of the new conversation', async ($, on) => {
  let release: () => void = () => {}
  const options: any = {}
  const { clock, opened } = await start($, on, options)
  options.holdRoot = new Promise<void>(resolve => (release = resolve))
  const before = opened.length
  const running = $.command.run({ command: 'dbt-show', args: 'orders' })
  // The command is under way, waiting for the session's root.
  for (let i = 0; i < 50; i++) await Promise.resolve()
  await $.session.end({ reason: 'clear' } as any)
  options.holdRoot = undefined
  release()
  await running
  await clock.settle()
  // Nor does it open an empty pane in the new conversation.
  expect(opened.length).toBe(before)
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 row/ })).toBeUndefined()
  await ui.unmount()
})

test('a model\'s own missing env_var keeps dbt\'s error on the note, the pane and the band, and still says to fix the model', async ($, on) => {
  const missing = "Compilation Error in model orders (models/orders.sql)\n  Env var required but not provided: 'START_DATE'"
  const { clock } = await start($, on, { show: { error: missing } })
  const result: any = await editOrders($)
  await clock.settle()
  const note = noteOf(result)
  expect(note).toContain("Env var required but not provided: 'START_DATE'")
  expect(note).not.toContain(PROFILES_FIXED)
  expect(note).toContain('Fix the model before going on')
  expect(note).not.toContain("may not be the model's fault")
  const pane = await $.ui.mount({ ...CHECK, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /START_DATE/ })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /START_DATE/ })).toBeDefined()
  await band.unmount()
  expect(profilesError(missing)).toBe(false)
  // The same message in a profile's template is still the profile's.
  expect(profilesError("Runtime Error\n  Could not render {{ env_var('X', 'S') }}: Env var required but not provided: 'X'")).toBe(true)
})

// ─── Values of the profile, removed from whatever dbt prints ────────────────────────────────────

// dbt and its adapters echo a field's value in errors that carry no heading of their own.
const VALUE_SHAPES: [string, string, string, string][] = [
  ['a connection URL pasted as the host', 'postgresql://alice:SENTINEL_HOST@db.example/d', 'Database Error\n  could not translate host name "postgresql://alice:SENTINEL_HOST@db.example/d" to address\n', 'SENTINEL_HOST'],
  ['a template that reads the wrong variable', 'SENTINEL_SSLMODE', 'Database Error\n  invalid sslmode value: "SENTINEL_SSLMODE"\n', 'SENTINEL_SSLMODE'],
  ['a target named by a template', 'SENTINEL_TARGET', "Runtime Error\n  The profile 'shop' does not have a target named 'SENTINEL_TARGET'\n", 'SENTINEL_TARGET'],
  ['a password reused through an alias', 'SENTINEL_ALIAS', "Runtime Error\n  at path ['threads']: 'SENTINEL_ALIAS' is not of type 'integer'\n", 'SENTINEL_ALIAS'],
  ['a JWT with a line break, printed as a bytes repr', 'eyJSENTINEL_JWT\n.sig', "Runtime Error\n  Invalid header value b'Bearer eyJSENTINEL_JWT\\n.sig'\n", 'SENTINEL_JWT'],
]

for (const [shape, value, text, secret] of VALUE_SHAPES) {
  test(`${shape}: the value never reaches the edit note, the check pane, the band, /dbt-show, its saved history or the doctor`, async ($, on) => {
    const check = await start($, on, { redact: [value], show: { raw: { exitCode: 2, stdout: text } }, debug: { exitCode: 2, stdout: `06:45:41  Connection test: [ERROR]\n${text}` } })
    const result: any = await editOrders($)
    await check.clock.settle()
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(noteOf(result)).toContain('‹redacted›')
    for (const [pane, name] of [[CHECK, 'check'], [BAND, 'band']] as const) {
      const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
      expect(await ui.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
      await ui.unmount()
      expect(name).toBeTruthy()
    }
    await $.command.run({ command: 'dbt-show', args: 'orders' })
    await check.clock.settle()
    const results = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
    expect(await results.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    await results.unmount()
    expect(JSON.stringify(check.store.get('dbt-results-history'))).not.toContain(secret)
    expect(check.toasts.join('\n')).not.toContain(secret)
    await $.command.run({ command: 'dbt-doctor', args: '' })
    await check.clock.settle()
    const doctor = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
    expect(await doctor.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    await doctor.unmount()
    await $.prompt.submit({ text: 'hello' })
    expect(check.prompts.join('\n')).not.toContain(secret)
  })

  test(`${shape}: the value never reaches the band, Explain or Fix for Claude's own failed command`, async ($, on) => {
    const { clock, prompts, setBash } = await start($, on, { redact: [value], runResultsAt: 1, now: 900_000 })
    setBash({ stdout: `${HEADER}\n${text}`, isError: true })
    await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
    await clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    await band.press({ key: 'dbt-explain' })
    await band.press({ key: 'dbt-fix' })
    await clock.settle()
    expect(prompts.length).toBe(2)
    for (const prompt of prompts) expect(prompt).not.toContain(secret)
    await band.unmount()
  })
}

kitTest('a value is removed as dbt may print it: as is, JSON-escaped, as a Python repr, and by each long line of it', () => {
  clearRedactions()
  setRedactions('/p', ['eyJHEAD_SECRET\n.sig\nTAIL_SECRET_LINE'])
  expect(redactValues('a eyJHEAD_SECRET\n.sig\nTAIL_SECRET_LINE b')).toBe('a ‹redacted› b')
  expect(redactValues('{"msg":"eyJHEAD_SECRET\\n.sig\\nTAIL_SECRET_LINE"}')).toBe('{"msg":"‹redacted›"}')
  expect(redactValues("b'Bearer eyJHEAD_SECRET\\n.sig\\nTAIL_SECRET_LINE'")).toBe("b'Bearer ‹redacted›'")
  // One long line of it, alone; the short line (.sig) is left.
  expect(redactValues('header eyJHEAD_SECRET only')).toBe('header ‹redacted› only')
  expect(redactValues('the .sig file')).toBe('the .sig file')
  expect(redactionForms("it's a\nb")).toContain("it\\'s a\\nb")
  // A value in a message that is not a profile error: removed, the rest kept.
  expect(scrubDbt('Database Error\n  bad value "eyJHEAD_SECRET"')).toBe('Database Error\n  bad value "‹redacted›"')
  // Another project's values are cleared with the conversation.
  clearRedactions()
  expect(redactValues('eyJHEAD_SECRET')).toBe('eyJHEAD_SECRET')
})

test('a node-scoped error block that carries profile text is replaced whole, not quoted', async ($, on) => {
  await start($, on)
  const text = 'Compilation Error in model orders (models/orders.sql)\n  Credentials in profile "shop", target "dev" invalid: 9912345 is not of type \'string\'\n'
  const failure = failuresFromText(text)[0]!
  expect(failure.message).toBe(`Compilation Error\n${PROFILES_FIXED}`)
})

test('a stored history entry whose error holds a profile error is scrubbed on load, and what is saved next never holds it', async ($, on) => {
  const old = { ...savedQuery('old', false), error: 'Runtime Error\n  Credentials in profile "shop", target "dev" invalid: 9912345 is not of type \'string\'' }
  const { clock, store } = await start($, on, { stored: { 'dbt-results-history': [old] } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const saved = store.get('dbt-results-history') as any[]
  expect(JSON.stringify(saved)).not.toContain('9912345')
  expect(saved.find(one => one.title === 'old').error).toBe(PROFILES_FIXED)
})

kitTest('what the write dropped leaves the history, but a newer run of the same query (same id) that replaced it meanwhile stays', () => {
  const dropped = { id: 'q', at: 1, title: 'old' }
  expect(withoutDropped([{ id: 'q', at: 1, title: 'old' }, { id: 'r', at: 2, title: 'other' }], [dropped]).map(one => one.title)).toEqual(['other'])
  expect(withoutDropped([{ id: 'q', at: 99, title: 'rerun' }], [dropped]).map(one => one.title)).toEqual(['rerun'])
})

for (const stderr of ['bash: ./scripts/helper: /gone/bin/python3: bad interpreter: No such file or directory', 'sh: ./hook: /usr/bin/python: cannot execute: required file not found']) {
  test(`a helper script's broken interpreter ("${stderr.slice(0, 40)}…") is not dbt that cannot run`, async ($, on) => {
    const { clock } = await start($, on, { show: { raw: { exitCode: 1, stdout: '', stderr } } })
    const note: any = await editOrders($)
    await clock.settle()
    expect(noteOf(note)).not.toContain('dbt could not be run here')
  })
}

// ─── The redaction survives /clear, follows the profile each invocation reads, and covers the doctor ──

const ALIAS_ERR = (secret: string) => `Runtime Error\n  at path ['threads']: '${secret}' is not of type 'integer'\n`

test('after /clear the same profile value is still removed: the notes and the saved history never carry it', async ($, on) => {
  const secret = 'SENTINEL_AFTER_CLEAR'
  const { clock, store } = await start($, on, { redact: [secret], show: { raw: { exitCode: 2, stdout: ALIAS_ERR(secret) } } })
  const before: any = await editOrders($)
  await clock.settle()
  expect(noteOf(before)).toContain('‹redacted›')
  await $.session.end({ reason: 'clear' } as any)
  const after: any = await editOrders($)
  await clock.settle()
  expect(JSON.stringify(after)).not.toContain(secret)
  expect(noteOf(after)).toContain('‹redacted›')
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  expect(JSON.stringify(store.get('dbt-results-history'))).not.toContain(secret)
})

const ALT_PROFILE = 'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      password: SENTINEL_ALT_PROFILE\n'

for (const [what, command] of [
  ['--profiles-dir ./config', 'dbt build --profiles-dir ./config -s orders'],
  ['a DBT_PROFILES_DIR prefix', 'DBT_PROFILES_DIR=./config dbt build -s orders'],
  ['a cd and a relative --profiles-dir', 'cd models && dbt build --profiles-dir ../config -s orders'],
] as const) {
  test(`${what}: the value of the profile it reads is removed from the band, Explain and Fix`, async ($, on) => {
    const secret = 'SENTINEL_ALT_PROFILE'
    const { clock, prompts, setBash } = await start($, on, {
      runResultsAt: 1,
      now: 900_000,
      files: { 'config/profiles.yml': ALT_PROFILE },
      // Only the alternate profile holds the value: the plugin's own profile has none.
      redactBy: { '/proj/config/profiles.yml': [secret] },
    })
    setBash({ stdout: `${HEADER}\n${ALIAS_ERR(secret)}`, isError: true })
    await $.tool.call({ tool: 'Bash', command })
    await clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    await band.press({ key: 'dbt-explain' })
    await band.press({ key: 'dbt-fix' })
    await clock.settle()
    expect(prompts.length).toBe(2)
    for (const prompt of prompts) expect(prompt).not.toContain(secret)
    await band.unmount()
  })
}

test('an inherited relative DBT_PROFILES_DIR is read from the folder the command ran in: that profile\'s value is removed', async ($, on) => {
  const secret = 'SENTINEL_ALT_PROFILE'
  const { clock, prompts, setBash } = await start($, on, {
    runResultsAt: 1,
    now: 900_000,
    env: { DBT_PROFILES_DIR: './config' },
    // dbt run from /proj/caller reads /proj/caller/config/profiles.yml, not the project's config folder.
    files: { 'caller/config/profiles.yml': ALT_PROFILE, 'config/profiles.yml': 'shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n' },
    redactBy: { '/proj/caller/config/profiles.yml': [secret] },
  })
  setBash({ stdout: `${HEADER}\n${ALIAS_ERR(secret)}`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'cd caller && dbt build --project-dir /proj -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts.length).toBe(1)
  expect(prompts[0]).not.toContain(secret)
  await band.unmount()
})

test('Re-run of a command that names another profiles folder removes that profile\'s value from the pane and the saved history', async ($, on) => {
  const secret = 'SENTINEL_ALT_PROFILE'
  const { clock, store, setBash } = await start($, on, {
    files: { 'config/profiles.yml': ALT_PROFILE },
    redactBy: { '/proj/config/profiles.yml': [secret] },
    show: { raw: { exitCode: 2, stdout: ALIAS_ERR(secret) } },
  })
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'dbt show --select orders --profiles-dir ./config' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  await ui.press({ key: 'results-rerun' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /redacted/ })).toBeDefined()
  expect(JSON.stringify(store.get('dbt-results-history'))).not.toContain(secret)
  await ui.unmount()
})

test('a target an env var gave, with no such output, is never echoed by the script or by the doctor, and a value in any doctor line is removed', async ($, on) => {
  const secret = 'SENTINEL_TARGET_FROM_ENV_VAR'
  // What a script that echoed the resolved target would say, and the redaction list for it.
  const { clock, prompts } = await start($, on, { redact: [secret], profileAnswer: { exitCode: 0, stdout: JSON.stringify({ status: 'no_output', profile: 'shop', target: secret }) } })
  await $.command.run({ command: 'dbt-doctor', args: '' })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /has no output/ })).toBeDefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'hello' })
  expect(prompts[0]).not.toContain(secret)
  expect(PROFILE_TYPE).toContain("out('no_output', profile=shown, target=echo)")
})

kitTest('the doctor note holds no profile value, whichever line carries it', () => {
  clearRedactions()
  setRedactions('/p', ['SENTINEL_NOTE_VALUE'])
  const note = doctorNote('/proj', [{ id: 'adapter', label: 'Adapter', status: 'fail', detail: 'profile shop has no output named SENTINEL_NOTE_VALUE', fix: 'use SENTINEL_NOTE_VALUE' }])
  expect(note).not.toContain('SENTINEL_NOTE_VALUE')
  clearRedactions()
})

// ─── What is redacted: dbt's messages, across /clear, from the folder dbt ran in ───────────────────

test('a /dbt-show under way when /clear ends the conversation is saved with the profile value removed', async ($, on) => {
  const url = 'postgresql://alice:SENTINEL_HELD_URL@db.example/d'
  let release: () => void = () => {}
  const holdShow = new Promise<void>(resolve => (release = resolve))
  const { clock, store, runs } = await start($, on, { redact: [url], holdShow, show: { raw: { exitCode: 2, stdout: `Database Error\n  could not translate host name "${url}" to address\n` } } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  // Until dbt show has started and is held: the profile's values were read before it.
  await clock.settle()
  expect(runs.some(argv => argv[1] === 'show' && !argv.includes('--inline'))).toBe(true)
  await $.session.end({ reason: 'clear' } as any)
  release()
  await clock.settle()
  const saved = JSON.stringify(store.get('dbt-results-history'))
  expect(saved).toContain('orders')
  expect(saved).not.toContain('SENTINEL_HELD_URL')
})

test('with no profiles folder named, the profiles.yml in the folder dbt ran in is the one whose values are removed', async ($, on) => {
  const secret = 'SENTINEL_CALLER_PROFILE'
  const { clock, prompts, setBash } = await start($, on, {
    cwd: '/proj/caller',
    runResultsAt: 1,
    now: 900_000,
    files: { 'caller/profiles.yml': 'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n      password: SENTINEL_CALLER_PROFILE\n' },
    redactBy: { '/proj/caller/profiles.yml': [secret] },
  })
  setBash({ stdout: `${HEADER}\n${ALIAS_ERR(secret)}`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build --project-dir /proj -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]).not.toContain(secret)
  await band.unmount()
})

test('two projects that read one profiles.yml each have its values loaded: the second is not skipped by the first\'s load', async ($, on) => {
  const { clock, setBash, redactSent } = await start($, on, { extraProjects: ['/proj2'], runResultsAt: 1, now: 900_000, files: { 'profiles.yml': 'shop:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n' } })
  setBash({ stdout: `${HEADER}\n`, isError: false })
  await $.tool.call({ tool: 'Bash', command: 'dbt build --project-dir /proj -s orders' })
  await $.tool.call({ tool: 'Bash', command: 'dbt build --project-dir /proj2 -s orders' })
  await clock.settle()
  expect(new Set(redactSent.filter(one => one.argv[4] === '/proj/profiles.yml').map(one => one.argv[3]))).toEqual(new Set(['/proj/dbt_project.yml', '/proj2/dbt_project.yml']))
})

test('a check that starts while another call loads the profile values waits for them, rather than reading dbt\'s error with none', async ($, on) => {
  let release!: () => void
  const secret = 'SENTINEL_RACE_PASSWORD'
  const { clock, setBash } = await start($, on, { redact: [secret], holdRedact: new Promise<void>(go => (release = go)), show: { raw: { exitCode: 2, stdout: ALIAS_ERR(secret) } } })
  setBash({ stdout: HEADER, isError: false })
  const first = $.tool.call({ tool: 'Bash', command: 'dbt build -s customers' })
  await clock.settle()
  const second = $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'a', new_string: 'b' })
  await clock.settle()
  release()
  const [, edited]: any[] = await Promise.all([first, second])
  await clock.settle()
  const notes = (edited.context ?? []).filter((note: string) => note.startsWith('Altimate compile-and-validate'))
  expect(notes.length).toBe(1)
  expect(notes.join('\n')).not.toContain(secret)
})

test('query rows are the person\'s data: a value that is also in the profile is shown as it is', async ($, on) => {
  const { clock } = await start($, on, { redact: ['SENTINEL_ROW_VALUE'], show: { rows: [{ schema_name: 'SENTINEL_ROW_VALUE' }] } })
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /SENTINEL_ROW_VALUE/ })).toBeDefined()
  await ui.unmount()
})

kitTest('env_var calls are read in the decoded values, and identifier keys are not secrets', () => {
  expect(PROFILE_REDACT).toContain('scan(profiles)')
  expect(PROFILE_REDACT).toContain("IDENTIFIERS = ('schema', 'database', 'dataset', 'project', 'catalog', 'warehouse', 'role', 'user')")
  expect(PROFILE_REDACT).toContain('key not in IDENTIFIERS')
})

// ─── Templates are rendered, not matched; a cut never leaves the start of a value ────────────────

kitTest('PROFILE_REDACT and PROFILE_TYPE render templates with a plain jinja2 Environment that has env_var alone', () => {
  for (const script of [PROFILE_REDACT, PROFILE_TYPE]) {
    expect(script).toContain('jinja2.Environment()')
    expect(script).toContain("engine.globals['env_var']")
    expect(script).not.toMatch(/exec\(|eval\(|extensions|SandboxedEnvironment|globals\['var'\]/)
  }
  expect(PROFILE_REDACT).toContain('render(name)')
})

const CUT_SECRET = 'SENTINEL_LONG_SECRET_VALUE_CROSSING_THE_CUT'
const CUT_RESULTS = (message: string) => ({ exitCode: 0, stdout: JSON.stringify({ results: [{ unique_id: 'test.shop.not_null_orders_amount.106140f9fd', status: 'error', message }], metadata: { invocation_id: 'inv-cut', generated_at: 'x' } }) })

test('the profile values go to the run_results script on stdin, never in its argv', async ($, on) => {
  const stdins: { argv: string[]; stdin: string | undefined }[] = []
  const options: any = { runResultsSize: 9 * 1024 * 1024, runResultsAt: 9_000_000, redact: [CUT_SECRET], runFailures: { exitCode: 0, stdout: JSON.stringify({ results: [] }) }, stdins }
  const { clock, setBash } = await start($, on, options)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  expect(stdins.length).toBeGreaterThan(0)
  for (const one of stdins) {
    expect(JSON.parse(one.stdin ?? 'null')).toEqual([CUT_SECRET])
    expect(one.argv.join(' ')).not.toContain(CUT_SECRET)
  }
})

test('a message cut at 2000 characters through a secret holds no start of it, in the band, Explain or Fix', async ($, on) => {
  // What an older script would give: the message cut through the value.
  const cut = `${'x'.repeat(1990)}${CUT_SECRET.slice(0, 10)}`
  // The artifact the command wrote: another invocation than the one seen before it.
  const options: any = { runResultsSize: 9 * 1024 * 1024, runResultsAt: 9_000_000, redact: [CUT_SECRET], runFailures: { exitCode: 0, stdout: JSON.stringify({ results: [] }) }, duringBash: async () => void (options.runFailures = CUT_RESULTS(cut)) }
  const { clock, prompts, setBash } = await start($, on, options)
  setBash({ stdout: BUILD_FAILED, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-explain' })
  await band.press({ key: 'dbt-fix' })
  await clock.settle()
  expect(prompts.length).toBe(2)
  for (const prompt of prompts) {
    expect(prompt).toContain('xxxx')
    expect(prompt).not.toContain('SENTINEL')
  }
  await band.unmount()
})

kitTest('a fragment of 6 or more characters at the end of a cut text that starts a held value is dropped', () => {
  clearRedactions()
  setRedactions('/p', [CUT_SECRET])
  expect(withoutValueFragment(`text ${CUT_SECRET.slice(0, 12)}`)).toBe('text ')
  expect(withoutValueFragment(`text ${CUT_SECRET.slice(0, 5)}`)).toBe(`text ${CUT_SECRET.slice(0, 5)}`)
  expect(withoutValueFragment('text SENTINEL_X')).toBe('text SENTINEL_X')
  clearRedactions()
})

kitTest('a run_results message cut at 2000 characters through a held value keeps no start of it', () => {
  clearRedactions()
  setRedactions('/p', [CUT_SECRET])
  const cut = `${'x'.repeat(1990)}${CUT_SECRET.slice(0, 10)}`
  const [failure] = failuresFrom(CUT_RESULTS(cut).stdout ? JSON.parse(CUT_RESULTS(cut).stdout) : null, MANIFEST)
  expect(failure!.message).toBe('x'.repeat(1990))
  clearRedactions()
})

// ─── Bytes reprs, and the assignments set for a command ─────────────────────────────────────────

test('a non-ASCII secret printed as a bytes repr is removed: the matcher cuts the \\xNN form the script lists', async ($, on) => {
  const { clock, setBash, prompts } = await start($, on, {
    runResultsAt: 1,
    now: 900_000,
    // What the script lists for the value: itself and the form Python prints it in.
    redact: ['SENTINEL_\u20ac_TOKEN', 'SENTINEL_\\xe2\\x82\\xac_TOKEN'],
  })
  setBash({ stdout: `${HEADER}\nRuntime Error\n  Invalid header value b'Bearer SENTINEL_\\xe2\\x82\\xac_TOKEN'\n`, isError: true })
  await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /SENTINEL/ })).toBeUndefined()
  await band.press({ key: 'dbt-explain' })
  await clock.settle()
  expect(prompts[0]).not.toContain('SENTINEL')
  expect(prompts[0]).toContain('Invalid header value')
  await band.unmount()
})

for (const [what, command] of [
  ['a prefix', 'DB_PASSWORD=SENTINEL_CMD_ENV_VALUE dbt build -s orders'],
  ['env', 'env DB_PASSWORD=SENTINEL_CMD_ENV_VALUE dbt build -s orders'],
  ['an earlier export', 'export DB_PASSWORD=SENTINEL_CMD_ENV_VALUE && dbt build -s orders'],
] as const) {
  test(`a value set for the command by ${what} is removed from the band, Explain and Fix: the script is sent it on stdin, never in argv`, async ($, on) => {
    const secret = 'SENTINEL_CMD_ENV_VALUE'
    const { clock, prompts, setBash, redactSent } = await start($, on, { runResultsAt: 1, now: 900_000, redactFrom: env => (env.DB_PASSWORD ? [env.DB_PASSWORD] : []) })
    setBash({ stdout: `${HEADER}\nDatabase Error\n  invalid sslmode value: "${secret}"\n`, isError: true })
    await $.tool.call({ tool: 'Bash', command })
    await clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    await band.press({ key: 'dbt-explain' })
    await band.press({ key: 'dbt-fix' })
    await clock.settle()
    expect(prompts.length).toBe(2)
    for (const prompt of prompts) expect(prompt).not.toContain(secret)
    const sent = redactSent.filter(one => one.stdin?.includes(secret))
    expect(sent.length).toBeGreaterThan(0)
    for (const one of sent) expect(one.argv.join(' ')).not.toContain(secret)
    await band.unmount()
  })
}

kitTest('dbt debug\'s error is scrubbed whole before it is cut, so a value that crosses the cut leaves no fragment', () => {
  const secret = 'SENTINEL_CROSSING_THE_CUT_VALUE'
  setRedactions('/proj', [secret])
  try {
    // The value starts 10 characters before the 300th, so a cut first would leave its first 10.
    const text = `Connection test: [ERROR] ${'x'.repeat(265)}${secret} trailing`
    const detail = debugInfo(text).detail ?? ''
    expect(detail).not.toContain('SENTINEL_')
    expect(detail).toContain('xxxx')
  } finally {
    clearRedactions()
  }
})

test('the plugin\'s own dbt runs write their artifacts to its own folder: the project\'s manifest, with every model\'s compiled SQL, is left as it was', async ($, on) => {
  const { clock, runs, envs, files, mtimes } = await start($, on, { manifestAfterShow: { ...MANIFEST, metadata: { invocation_id: 'plugin-show' } } })
  const kept = files['target/manifest.json']
  const keptAt = mtimes['target/manifest.json']
  // The check of an edit, then /dbt-show.
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/orders.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  await $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.settle()
  const shows = runs.map((argv, i) => ({ argv, env: envs[i]! })).filter(one => one.argv[0] === DBT && one.argv.includes('show'))
  expect(shows).toHaveLength(2)
  for (const one of shows) expect(one.env.DBT_TARGET_PATH).toBe(`${ROOT}/target/.altimate-plugin`)
  expect(files['target/manifest.json']).toBe(kept)
  expect(mtimes['target/manifest.json']).toBe(keptAt)
  // The check reads the manifest its own dbt show wrote: the model as it is now.
  expect(files['target/.altimate-plugin/manifest.json']).toContain('plugin-show')
  expect(result.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toBeDefined()
})

test('the doctor\'s Run dbt parse, which the person presses to refresh a stale manifest, writes the project\'s own manifest', async ($, on) => {
  const { clock, runs, envs } = await start($, on, { interactive: true, now: 200_000, mtimes: { 'models/orders.sql': 5_000 } })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dbt-doctor-parse' })
  await clock.settle()
  await band.unmount()
  const parse = runs.findIndex(argv => argv[0] === DBT && argv[1] === 'parse')
  expect(parse).toBeGreaterThanOrEqual(0)
  expect(envs[parse]!.DBT_TARGET_PATH).toBeUndefined()
})

test('Re-run of Claude\'s dbt show drops the artifact folder Claude named: the replay writes to the plugin\'s own', async ($, on) => {
  expect(replayArgv(['dbt', 'show', '-s', 'orders', '--target-path', 'target'], 5)).toEqual(['dbt', 'show', '-s', 'orders', '--limit', '5', '--output', 'json', '--log-format', 'json'])
  expect(replayArgv(['dbt', 'show', '--target-path=target', '-s', 'orders'], 5)).toEqual(['dbt', 'show', '-s', 'orders', '--limit', '5', '--output', 'json', '--log-format', 'json'])
  const { clock, runs, envs, setBash, files } = await start($, on)
  const kept = files['target/manifest.json']
  setBash({ stdout: showLog([{ order_id: 1 }], 'orders') })
  await $.tool.call({ tool: 'Bash', command: 'dbt show -s orders --target-path target' })
  await clock.settle()
  const ui = await $.ui.mount({ ...RESULTS, surface: 'terminal' })
  await ui.press({ key: 'results-rerun' })
  await clock.settle()
  await ui.unmount()
  const replay = runs.findIndex(argv => argv[0] === DBT && argv[1] === 'show')
  expect(replay).toBeGreaterThanOrEqual(0)
  expect(runs[replay]).not.toContain('--target-path')
  expect(envs[replay]!.DBT_TARGET_PATH).toBe(`${ROOT}/target/.altimate-plugin`)
  expect(files['target/manifest.json']).toBe(kept)
})

test('a check reads the manifest its dbt show wrote before the plugin\'s next queued dbt run can write over it', async ($, on) => {
  let release!: () => void
  let readable!: () => void
  // The check's read of its manifest is slow: the queued run would start meanwhile if the queue were not held.
  const statGate = { path: 'target/.altimate-plugin/manifest.json', until: new Promise<void>(resolve => (readable = resolve)) }
  const { clock, order } = await start($, on, { holdShow: new Promise<void>(resolve => (release = resolve)), statGate })
  const edit = $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/orders.sql`, old_string: 'a', new_string: 'b' })
  await clock.advance(10)
  // A /dbt-show queued behind the check's own show.
  const shown = $.command.run({ command: 'dbt-show', args: 'orders' })
  await clock.advance(10)
  release()
  for (let i = 0; i < 5; i++) await clock.advance(10)
  readable()
  await Promise.all([edit, shown])
  await clock.settle()
  const shows = order.map((one, i) => (one === 'dbt show' ? i : -1)).filter(i => i >= 0)
  expect(shows.length).toBeGreaterThanOrEqual(2)
  const read = order.findIndex((one, i) => i > shows[0]! && one === 'read target/.altimate-plugin/manifest.json')
  expect(read).toBeGreaterThan(shows[0]!)
  expect(read).toBeLessThan(shows[1]!)
})

test('the model-context toast counts the columns schema.yml lists as such, in the singular for one', async ($, on) => {
  const orders = (MANIFEST.nodes as any)['model.shop.orders']
  const one = { ...MANIFEST, nodes: { ...MANIFEST.nodes, 'model.shop.orders': { ...orders, columns: { order_id: orders.columns.order_id } } } }
  const { clock, toasts } = await start($, on, { files: { 'target/manifest.json': JSON.stringify(one) } })
  const result: any = await $.tool.call({ tool: 'Read', file_path: ORDERS })
  await clock.settle()
  expect(toasts.find(one => one.startsWith('◆ model context · orders'))).toBe('◆ model context · orders: table · 1 column in schema.yml · 1 test · depth 2↑ 1↓')
  expect(result.context[0]).toContain('- columns schema.yml lists (1; the model may return more):')
})

/** The dbt helpers with `info_toasts` off. */
const quiet = { options: { dbt_mods: true, info_toasts: false } }

kitTest('with info_toasts off, model context and a passing check raise no toast; the transcript line, the band and a failure toast stay', quiet, async ($: any, on: any) => {
  const logs: string[] = []
  const { clock, toasts } = await start($, on, { logs, show: { rows: [{ order_id: 1, order_total: 10 }] } })
  const read: any = await $.tool.call({ tool: 'Read', file_path: ORDERS })
  await clock.settle()
  expect(read.context[0]).toContain('dbt model context for orders')
  expect(logs).toContain("model-context · added to Claude's context: orders.sql")
  const edited: any = await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'as amount', new_string: 'as order_total' })
  await clock.settle()
  expect(edited.context?.find((one: string) => one.startsWith('Altimate compile-and-validate'))).toContain('- returned but not documented in schema.yml: order_total')
  expect(toasts.filter(one => /model context|compiled and validated|dbt doctor · /.test(one) && !one.startsWith('⚕'))).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Compile & validate/ })).toBeDefined()
  await band.unmount()
})


kitTest('with info_toasts off, a passing doctor raises no toast; a doctor that finds a problem still does', quiet, async ($: any, on: any) => {
  const { clock, toasts } = await start($, on, { interactive: true })
  await clock.settle()
  expect(toasts.filter(one => one.includes('dbt doctor'))).toEqual([])
})

kitTest('with info_toasts off, the doctor that finds a stale manifest still raises its toast', quiet, async ($: any, on: any) => {
  const { clock, toasts } = await start($, on, { interactive: true, now: 200_000, mtimes: { 'models/orders.sql': 5_000 } })
  await clock.settle()
  expect(toasts).toContain('⚕ dbt doctor · Manifest needs attention')
})

kitTest('with info_toasts off, a passing recheck raises no toast but the band says so; a failed edit check still toasts', quiet, async ($: any, on: any) => {
  const show: Options['show'] = { rows: [{ order_id: 1, order_total: 10 }] }
  const { clock, mtimes, toasts } = await start($, on, { show })
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'as amount', new_string: 'as order_total' })
  await clock.settle()
  show!.rows = [{ order_id: 1, amount: 10 }]
  mtimes['models/orders.sql'] = 50_000
  await $.tool.call({ tool: 'Bash', command: 'altimate run "fix it, then dbt build" --agent builder' })
  await clock.settle()
  expect(toasts.some(one => one.includes('checked again'))).toBe(false)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /2 columns · match schema\.yml/ })).toBeDefined()
  await band.unmount()

  show!.error = BINDER
  delete show!.rows
  await $.tool.call({ tool: 'Write', file_path: ORDERS, content: 'select order_dte from x' })
  await clock.settle()
  expect(toasts).toContain('✖ orders · dbt could not compile or run it · see the band')
})

test('a doctor shown before an edit reads the manifest again after it: it no longer says current once a model file is newer', async ($, on) => {
  const { clock, mtimes } = await start($, on, { interactive: true, now: 200_000, show: { rows: [{ order_id: 1, amount: 10 }] } })
  await clock.settle()
  const ui = await $.ui.mount({ ...DOCTOR, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^current \(written \d+ min ago\)$/ })).toBeDefined()
  mtimes['models/orders.sql'] = 150_000
  await $.tool.call({ tool: 'Edit', file_path: ORDERS, old_string: 'select *', new_string: 'select  *' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^current \(written/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /stale: 1 file changed since it was written .* \(models\/orders\.sql\)/ })).toBeDefined()
  // dbt parse, run by Claude, writes a newer manifest: the pane says current again.
  mtimes['target/manifest.json'] = 160_000
  await $.tool.call({ tool: 'Bash', command: 'dbt parse' } as any)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^current \(written \d+ min ago\)$/ })).toBeDefined()
  await ui.unmount()
})
