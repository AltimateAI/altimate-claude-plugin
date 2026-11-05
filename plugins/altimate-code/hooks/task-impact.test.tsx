import { expect, mock, test } from 'claude-code/testing'

import { DOWN, UP, embedded } from './impact-report.test'

const ROOT = '/repo'
const MANIFEST = `${ROOT}/target/manifest.json`
const SNAPSHOT = `${ROOT}/target/.altimate-lineage/manifest-before.json`
const REPORT = `${ROOT}/target/.altimate-lineage/report.html`
const MODEL = `${ROOT}/models/fct_orders.sql`
const STAGING = `${ROOT}/models/stg_payments.sql`
const MACRO = `${ROOT}/macros/cents.sql`
const SNAPSHOT_SQL = `${ROOT}/snapshots/orders_snap.sql`

const BAND = {
  plugin: 'altimate-code',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const ORDERS_SQL = 'select\n  order_id,\n  sum(amount) as revenue\nfrom {{ ref("int_orders") }}\ngroup by 1\n'
const PAYMENTS_SQL = 'select\n  payment_id,\n  amount_cents / 100 as amount\nfrom {{ source("raw", "payments") }}\nwhere status = \'ok\'\n'

type Options = {
  /** What `uname -s` prints; null when it cannot start (Windows). */
  uname?: string | null
  /** Exit code per opener command; a command missing here cannot start. */
  openers?: Record<string, number>
  /** Files git sees as changed against HEAD, project-relative. */
  gitChanged?: () => string[]
  /** HEAD's text per project-relative path. */
  head?: Record<string, string>
  noManifest?: boolean
}

/**
 * A dbt project at /repo in a git repo, its files held in memory (edits apply to them), altimate-code
 * over MCP answering impact_analysis with a column answer per direction, and an opener per platform.
 */
async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on)
  const files: Record<string, string> = {
    [`${ROOT}/dbt_project.yml`]: "name: 'shop'\nmodel-paths: ['models']\n",
    [MODEL]: ORDERS_SQL,
    [STAGING]: PAYMENTS_SQL,
    [MACRO]: '{% macro cents(x) %}{{ x }} / 100{% endmacro %}',
    [SNAPSHOT_SQL]: '{% snapshot orders_snap %}select id, status from orders{% endsnapshot %}',
  }
  const runs: string[][] = []
  const tools: Record<string, any>[] = []
  const writes = new Map<string, string>()
  const logs: string[] = []
  on('command.register', () => ({ value: { command: 'x' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.open', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_: unknown, e: { text: string }) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path in files || (e.path === MANIFEST && !options.noManifest) || writes.has(e.path) }))
  on('fs.stat', (_: unknown, e: { path: string }) => {
    if (e.path === MANIFEST && options.noManifest) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 50 * 1024 * 1024, mtimeMs: 1, isLink: false } }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path === MANIFEST) throw new Error('over 4 MiB')
    if (e.path in files) return { value: files[e.path] }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:altimate-code:altimate-code' } }))
  on('mcp.call', (_: unknown, e: { tool: string; args: Record<string, any> }) => {
    if (e.tool !== 'impact_analysis') return { value: { content: [], isError: true } }
    tools.push(e.args)
    // impactFirst's own call (no direction) gets the older column reach shape.
    const body = !e.args.direction
      ? { severity: 'LOW', direct_count: 4, transitive_count: 2, column_reach: { models: [], exposures: [] } }
      : !e.args.column
        ? { severity: 'LOW', direct_count: 4, transitive_count: 2 }
        : { severity: 'LOW', direct_count: 4, transitive_count: 2, column_answer: e.args.direction === 'upstream' ? UP : DOWN }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ ...body, report: 'Impact' }) }], isError: false } }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const argv = [...e.argv]
    runs.push(argv)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    const [bin] = argv
    if (bin === 'mkdir' || bin === 'cp') return ok()
    if (bin === 'git') {
      const sub = argv[3]
      if (sub === 'rev-parse') return ok(`${ROOT}\n`)
      if (sub === 'diff') return ok((options.gitChanged?.() ?? []).join('\n'))
      if (sub === 'ls-files') return ok('')
      if (sub === 'show') {
        const path = argv[4]!.replace(/^HEAD:/, '')
        return path in (options.head ?? {}) ? ok(options.head![path]) : { value: { exitCode: 128, stdout: '', stderr: 'no such path' } }
      }
    }
    if (bin === 'uname') {
      if (options.uname === null) throw new Error('ENOENT: uname not found')
      return ok(`${options.uname ?? 'Linux'}\n`)
    }
    if (bin === 'wslpath') return ok('\\\\wsl.localhost\\dev\\repo\\target\\.altimate-lineage\\report.html\n')
    const code = options.openers?.[bin!]
    if (code === undefined) throw new Error(`ENOENT: ${bin} not found`)
    return { value: { exitCode: code, stdout: '', stderr: '' } }
  })
  // The tool beneath the plugin: an Edit applies to the files.
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'Edit' && e.file_path in files) files[e.file_path] = files[e.file_path]!.replace(e.old_string, e.new_string)
    if (e.tool === 'Write') files[e.file_path] = e.content
    return { result: { ok: true } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const turn = async (id: string, work: () => Promise<void>) => {
    await $.turn.start({ text: 'change it', turnId: id })
    await clock.settle()
    await work()
    await clock.settle()
    await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answer', turnId: id } as any)
    await clock.settle()
  }
  return { clock, files, runs, tools, writes, logs, turn }
}

const directional = (tools: Record<string, any>[]) => tools.filter(one => one.direction)

test('a task start copies the manifest aside, never reading it', async ($, on) => {
  const { runs, turn } = await start($, on)
  await turn('t1', async () => {})
  expect(runs).toContainEqual(['mkdir', '-p', `${ROOT}/target/.altimate-lineage`])
  expect(runs).toContainEqual(['cp', MANIFEST, SNAPSHOT])
  expect(runs.findIndex(one => one[0] === 'mkdir')).toBeLessThan(runs.findIndex(one => one[0] === 'cp'))
})

test('an edited model is traced both ways from the snapshot at the task end, and the band sums it up', async ($, on) => {
  const { tools, writes, turn, clock, logs } = await start($, on)
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) - sum(refunds) as revenue' })
    // A second edit of the same file: the original stays the one from before the first.
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'order_id,', new_string: 'order_id ,' })
  })
  expect(directional(tools)).toEqual([
    { manifest_path: SNAPSHOT, model: 'fct_orders', column: 'revenue', change_type: 'modify', direction: 'downstream' },
    { manifest_path: SNAPSHOT, model: 'fct_orders', column: 'revenue', change_type: 'modify', direction: 'upstream' },
  ])
  expect(logs.some(line => line.startsWith('◆ Lineage after this task'))).toBe(true)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: '◆ Lineage after this task · 1 model changed' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'fct_orders · 6 downstream models at model level' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '  revenue Σ  reaches 4 columns in 3 models (2 ends) · 1 may carry it · 2 cleared' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '⚠ Lower bound: 1 model could not be read' })).toBeDefined()
  expect(await band.find({ key: 'lineage-report-open' })).toBeDefined()
  expect(await band.find({ key: 'lineage-open' })).toBeDefined()
  await band.press({ key: 'lineage-summary-dismiss' })
  await clock.settle()
  expect(await band.find({ key: 'lineage-report-open' })).toBeUndefined()
  await band.unmount()

  const report = embedded(writes.get(REPORT)!)
  expect(report.changes).toEqual([
    { model: 'fct_orders', file: 'models/fct_orders.sql', columns: [{ name: 'revenue', before: 'sum(amount) as revenue', after: 'sum(amount) - sum(refunds) as revenue' }] },
  ])
  expect(report.focuses[0].down.hops.length).toBe(3)
  expect(report.focuses[0].up.hops.length).toBe(2)
})

test('model files changed outside the edit tools are found through git, and only what changed this task', async ($, on) => {
  let changed: string[] = ['models/fct_orders.sql']
  const opts = { gitChanged: () => changed, head: { 'models/stg_payments.sql': PAYMENTS_SQL, 'macros/cents.sql': 'x', 'snapshots/orders_snap.sql': 'x' } }
  const { tools, files, turn } = await start($, on, opts)
  await turn('t1', async () => {
    // A sed in Bash: git sees the file, HEAD has its text before. fct_orders was already dirty
    // before the task and is untouched by it; a macro is not a model, and impact_analysis takes no snapshot.
    files[STAGING] = PAYMENTS_SQL.replace('amount_cents / 100 as amount', 'amount_cents / 100.0 as amount')
    files[MACRO] = 'changed'
    files[SNAPSHOT_SQL] = '{% snapshot orders_snap %}select id, upper(status) as status from orders{% endsnapshot %}'
    changed = ['models/fct_orders.sql', 'models/stg_payments.sql', 'macros/cents.sql', 'snapshots/orders_snap.sql']
  })
  expect(directional(tools).map(one => `${one.model}.${one.column}:${one.direction}`)).toEqual(['stg_payments.amount:downstream', 'stg_payments.amount:upstream'])
})

test('a change to no output column falls back to the model-level count', async ($, on) => {
  const { tools, writes, turn } = await start($, on)
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: STAGING, old_string: "status = 'ok'", new_string: "status in ('ok', 'settled')" })
  })
  expect(directional(tools)).toEqual([{ manifest_path: SNAPSHOT, model: 'stg_payments', change_type: 'modify', direction: 'downstream' }])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'stg_payments · 6 downstream models at model level' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '  no output column changed: the model-level count stands' })).toBeDefined()
  await band.unmount()
  expect(embedded(writes.get(REPORT)!).focuses[0]).toMatchObject({ model: 'stg_payments', column: null, modelLevel: 6 })
})

test('a task that changes no model shows nothing, and the next task clears the last summary', async ($, on) => {
  const { tools, turn } = await start($, on)
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await turn('t2', async () => {})
  expect(directional(tools).length).toBe(2)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'lineage-report-open' })).toBeUndefined()
  await band.unmount()
})

test('Open report on WSL falls back to explorer.exe, whose exit 1 is success; /lineage-report opens the last report', async ($, on) => {
  mock.env(on, { WSL_DISTRO_NAME: 'dev' })
  const { runs, turn, clock } = await start($, on, { openers: { 'explorer.exe': 1 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  expect(runs).toContainEqual(['wslview', REPORT])
  expect(runs).toContainEqual(['wslpath', '-w', REPORT])
  expect(runs).toContainEqual(['explorer.exe', '\\\\wsl.localhost\\dev\\repo\\target\\.altimate-lineage\\report.html'])
  // Opened: no fallback path is shown.
  expect(await band.find({ type: 'Text', text: /No browser opened/ })).toBeUndefined()
  await band.unmount()

  const out: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(out.text).toBe(`Opened the column impact report: ${REPORT}`)
})

test('when no browser opens, the band shows the report path as a link', async ($, on) => {
  const { runs, turn, clock } = await start($, on, { uname: 'Linux', openers: { 'xdg-open': 3 } })
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'lineage-report-open' })
  await clock.settle()
  expect(runs).toContainEqual(['xdg-open', REPORT])
  expect(await band.find({ type: 'Text', text: /No browser opened/ })).toBeDefined()
  expect(await band.find({ type: 'Link' })).toBeDefined()
  await band.unmount()
})

test('macOS opens with open; /lineage-report before any report says so', async ($, on) => {
  const { runs, turn } = await start($, on, { uname: 'Darwin', openers: { open: 0 } })
  const none: any = await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(none.text).toBe('No column impact report yet: one is written when a task changes a dbt model.')
  await turn('t1', async () => {
    await $.tool.call({ tool: 'Edit', file_path: MODEL, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) * 2 as revenue' })
  })
  await $.command.run({ command: 'lineage-report', args: '' } as any)
  expect(runs).toContainEqual(['open', REPORT])
})
