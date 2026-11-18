import { expect, mock, test } from 'claude-code/testing'

import { cteCount, inputsOf, orderNodes } from './sql-graph'

const ROOT = '/repo'
const FILE = `${ROOT}/models/fct_orders.sql`

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-sql-graph',
  props: { title: 'SQL graph', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

// The backend's answer for a model with two CTEs, as the tool returns it (response order is not dependency order).
const GRAPH = {
  nodes: [
    { id: 'fct_orders', name: 'fct_orders', type: 'model', nodeId: 'model.shop.fct_orders', sql: 'select * from paid', columns: [{ name: 'order_id' }, { name: 'amount' }] },
    { id: 'paid', name: 'paid', type: 'cte', sql: 'select order_id, amount\nfrom orders\nwhere status = \'paid\'', columns: [{ name: 'order_id' }, { name: 'amount' }] },
    { id: 'orders', name: 'orders', type: 'model', nodeId: 'model.shop.stg_orders', sql: '', columns: [{ name: 'order_id' }, { name: 'amount' }, { name: 'status' }] },
  ],
  edges: [
    ['orders', 'paid'],
    ['paid', 'fct_orders'],
  ],
}

type Options = { answer?: Record<string, unknown>; fail?: string; sql?: string; noProject?: boolean; ok?: boolean; okOutput?: string; hold?: Record<string, Promise<void>>; holdFirst?: Promise<void>; yml?: string }

async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on)
  const cli: string[][] = []
  const reads: string[] = []
  on('command.register', () => ({ value: { command: 'sql-graph' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.open', () => ({ value: {} }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: !options.noProject && (e.path === `${ROOT}/dbt_project.yml` || e.path === `${ROOT}/dbt_packages/pkg/dbt_project.yml` || e.path === `${ROOT}/dbt_packages/vendor/pkg/dbt_project.yml` || e.path === `${ROOT}/vendor/pkg/dbt_project.yml` || e.path === `${ROOT}/vendor/pkg/nested/child/dbt_project.yml`) }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    reads.push(e.path)
    return { value: e.path === `${ROOT}/dbt_project.yml` ? (options.yml ?? "name: 'shop'\n") : (options.sql ?? 'select 1') }
  })
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    const [, command] = e.argv
    // The integrations half of the plugin asks the CLI for its status at session start.
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    cli.push([...e.argv])
    const asked = JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1] ?? '{}')).model as string
    // A test can hold one model's answer to make it arrive after a newer ask's.
    if (options.hold?.[asked]) await options.hold[asked]
    // The first ask is held and answers with a graph of its own; later asks answer at once.
    const nth = cli.length
    if (options.holdFirst && nth === 1) {
      await options.holdFirst
      return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: { success: true, model: asked, nodes: [{ id: 'stale', name: 'stale', type: 'cte', sql: '', columns: [] }], edges: [] } }), stderr: '' } }
    }
    if (options.ok === false) return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: options.okOutput ?? 'Not available: this needs the dbt adapter', metadata: { success: false, reason: 'read-only', error: 'Not available: this needs the dbt adapter' } }), stderr: '' } }
    if (options.fail) return { value: { exitCode: 1, stdout: JSON.stringify({ status: 'error', output: options.fail, metadata: { success: false } }), stderr: '' } }
    const metadata = { success: true, model: asked, ...(options.answer ?? GRAPH) }
    return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: 'SQL graph for fct_orders', metadata }), stderr: '' } }
  })
  on('tool.call', () => ({ result: { ok: true } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, cli, reads }
}

const composer = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

test('orderNodes puts each node after what feeds it, whatever order the backend listed them in', () => {
  expect(orderNodes(GRAPH as any).map(node => node.id)).toEqual(['orders', 'paid', 'fct_orders'])
  expect(inputsOf(GRAPH as any, 'fct_orders')).toEqual(['paid'])
  expect(inputsOf(GRAPH as any, 'orders')).toEqual([])
})

test('orderNodes keeps the listed order for nodes with no edges and survives a cycle', () => {
  const alone = { nodes: [{ id: 'b' }, { id: 'a' }], edges: [] } as any
  expect(orderNodes(alone).map(node => node.id)).toEqual(['b', 'a'])
  const cycle = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [['a', 'b'], ['b', 'a']] } as any
  expect(orderNodes(cycle).map(node => node.id).sort()).toEqual(['a', 'b'])
})

test('a model is the .sql file in a dbt project\'s model folders: by file name, not by an ancestor folder, and never a macro, test, snapshot or build file', async ($, on) => {
  const { clock } = await start($, on, { yml: "name: 'shop'\nmodel-paths: ['models', 'more_models']\n" })
  const reads = async (file: string) => {
    await $.tool.call({ tool: 'Read', file_path: file })
    await clock.settle()
    return (await $.command.run({ command: 'sql-graph', args: '', ...composer } as any)).text
  }
  expect(await reads(`${ROOT}/more_models/marts/dim_a.sql`)).toContain('dim_a')
  expect(await reads(`${ROOT}/macros/cents.sql`)).toContain('dim_a')
  expect(await reads(`${ROOT}/tests/t.sql`)).toContain('dim_a')
  expect(await reads(`${ROOT}/target/compiled/shop/models/x.sql`)).toContain('dim_a')
  expect(await reads(`${ROOT}/db/migrations/001.sql`)).toContain('dim_a')
  expect(await reads(`${ROOT}/models/fct_orders.sql`)).toContain('fct_orders')
  // A folder inside a model path keeps its name; a package's own models are not the project's.
  expect(await reads(`${ROOT}/models/tests/in_models.sql`)).toContain('in_models')
  expect(await reads(`${ROOT}/dbt_packages/pkg/models/p.sql`)).toContain('in_models')
})

test('a package installed deeper in the default folder, or under the project\'s packages-install-path, is not the project\'s model', async ($, on) => {
  const { clock } = await start($, on, { yml: "name: 'shop'\npackages-install-path: vendor\n" })
  const reads = async (file: string) => {
    await $.tool.call({ tool: 'Read', file_path: file })
    await clock.settle()
    return (await $.command.run({ command: 'sql-graph', args: '', ...composer } as any)).text
  }
  expect(await reads(`${ROOT}/models/fct_orders.sql`)).toContain('fct_orders')
  expect(await reads(`${ROOT}/vendor/pkg/models/v.sql`)).toContain('fct_orders')
  expect(await reads(`${ROOT}/dbt_packages/vendor/pkg/models/d.sql`)).toContain('fct_orders')
  // A project nested inside an installed package is a package's too: the outer project is still asked.
  expect(await reads(`${ROOT}/vendor/pkg/nested/child/models/n.sql`)).toContain('fct_orders')
})

// A configured folder that is not the project's own vendor folder leaves the models in it alone.
for (const path of ['C:\\repo\\vendor', '../vendor', '/vendor', 'vendor/repo/', '/vendor/repo/', `cache${ROOT}/vendor`, `/opt${ROOT}/vendor`])
  test(`a packages-install-path of ${path} hides none of the project's own models`, async ($, on) => {
    const { clock } = await start($, on, { yml: `name: 'shop'\npackages-install-path: ${path}\n` })
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/vendor/pkg/models/v.sql` })
    await clock.settle()
    expect((await $.command.run({ command: 'sql-graph', args: '', ...composer } as any)).text).toMatch(/SQL graph for v\b/)
  })

for (const path of [`${ROOT}/vendor`, 'vendor/./', './vendor', 'cache/../vendor', `${ROOT}/cache/../vendor`])
  test(`a packages-install-path written ${path.startsWith('/') ? 'as an absolute path inside the project' : `as ${path}`} is the same folder`, async ($, on) => {
    const { clock } = await start($, on, { yml: `name: 'shop'\npackages-install-path: ${path}\n` })
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/models/fct_orders.sql` })
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/vendor/pkg/models/v.sql` })
    await clock.settle()
    expect((await $.command.run({ command: 'sql-graph', args: '', ...composer } as any)).text).toContain('fct_orders')
  })

test('outside a dbt project a .sql read sets no default model and an edit adds no line', async ($, on) => {
  const { clock, cli } = await start($, on, { noProject: true, sql: 'with a as (select 1) select * from a' })
  const edit: any = await $.tool.call({ tool: 'Edit', file_path: '/other/models/x.sql', old_string: '1', new_string: '2' })
  await clock.settle()
  expect(JSON.stringify(edit.context ?? [])).not.toContain('/sql-graph')
  const reply = await $.command.run({ command: 'sql-graph', args: '', ...composer } as any)
  expect(reply.text).toBe('Read or edit a dbt model, or run /sql-graph <model>.')
  expect(cli).toHaveLength(0)
})

test('cteCount counts the CTEs a model defines, not words in comments or strings', () => {
  expect(cteCount('with a as (select 1), b as (select 2), "c" as (select 3) select * from a')).toBe(3)
  expect(cteCount('with recursive r as (select 1) select * from r')).toBe(1)
  expect(cteCount("-- with x as (\nselect ', y as (' as s from t")).toBe(0)
  expect(cteCount('select cast(a as int), b as c from t')).toBe(0)
  expect(cteCount("with a as (select '--' as marker), b as (select 1) select * from b")).toBe(2)
  expect(cteCount('{# with fake as (select 1) #}\nselect 1')).toBe(0)
  expect(cteCount(`select "it's" as c; with x as (select 1) select '--' from x`)).toBe(1)
  expect(cteCount('with "my cte" as (select 1) select 1')).toBe(1)
  expect(cteCount('with a (id) as (select 1), b(x, y) as (select 2, 3) select * from a')).toBe(2)
})

test('/sql-graph <model> asks the tool once, with write permission, and the pane lists the nodes in dependency order', async ($, on) => {
  const { clock, cli } = await start($, on)
  const reply = await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  expect(reply.text).toBe('The SQL graph for fct_orders is open.')
  expect(cli).toHaveLength(1)
  expect(cli[0]).toContain('dbt_sql_graph')
  expect(cli[0]).toContain('--allow-write')
  expect(JSON.parse(cli[0]![cli[0]!.indexOf('--args') + 1]!)).toEqual({ model: 'fct_orders' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /SQL graph · fct_orders · 3 nodes/ })).toBeDefined()
  // The backend lists fct_orders first; the pane draws each node after what feeds it.
  expect((await ui.findAll({ type: 'Button' })).map(row => row.key)).toEqual(['node-orders', 'node-paid', 'node-fct_orders'])
  expect(await ui.find({ type: 'Text', text: 'Press a row to see its SQL.' })).toBeDefined()
  await ui.unmount()
})

test('pressing a row shows that node\'s SQL', async ($, on) => {
  const { clock } = await start($, on)
  await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'node-paid' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'from orders' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: "where status = 'paid'" })).toBeDefined()
  await ui.unmount()
})

test('two nodes with one name stay two rows, each with its own inputs and SQL', async ($, on) => {
  const answer = {
    nodes: [
      { id: 'analytics.customers_1', name: 'customers', type: 'model', nodeId: 'model.shop.customers', sql: 'analytics.customers', columns: [] },
      { id: 'raw.customers_2', name: 'customers', type: 'source', nodeId: 'source.shop.raw.customers', sql: 'raw.customers', columns: [] },
      { id: 'LEFT_JOIN_9', name: 'LEFT_JOIN_9', type: 'LEFT_JOIN', sql: 'LEFT JOIN raw.customers', columns: [] },
    ],
    edges: [
      ['analytics.customers_1', 'LEFT_JOIN_9'],
      ['raw.customers_2', 'LEFT_JOIN_9'],
    ],
  }
  const { clock } = await start($, on, { answer })
  await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'node-analytics.customers_1' })).toBeDefined()
  expect(await ui.find({ key: 'node-raw.customers_2' })).toBeDefined()
  expect(inputsOf(answer as any, 'LEFT_JOIN_9')).toEqual(['analytics.customers_1', 'raw.customers_2'])
  await ui.press({ key: 'node-raw.customers_2' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'raw.customers' })).toBeDefined()
  await ui.unmount()
})

test('text from the CLI, the repo and the backend is drawn without escape or control characters, and a long statement is cut', async ($, on) => {
  const esc = String.fromCharCode(27)
  const bad = `bad${esc}]0;owned\u0007${esc}[31mred${esc}[0m\u2028end`
  const { clock } = await start($, on, { fail: bad })
  const reply = await $.command.run({ command: 'sql-graph', args: `m${esc}]0;x\u0007odel`, ...composer } as any)
  await clock.settle()
  expect(reply.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const drawn = JSON.stringify(await ui.find({ type: 'Text', text: /bad/ }))
  expect(drawn).not.toMatch(/u001b|u0007/)
  expect(drawn).not.toContain('\u2028')
  await ui.unmount()
})

test('a graph whose names, types and SQL carry escape and control characters is drawn as plain text', async ($, on) => {
  const esc = String.fromCharCode(27)
  const dirty = (word: string) => `${word}${esc}[31m!${esc}]0;x\u0007\u2028end`
  const answer = {
    nodes: [
      { id: 'a', name: dirty('src'), type: dirty('model'), sql: '', columns: [] },
      { id: 'b', name: dirty('out'), type: 'cte', sql: `select${esc}[1m 1\u0007\nfrom${esc}]0;x\u0007 a\u2028`, columns: [] },
    ],
    edges: [['a', 'b']],
  }
  const { clock } = await start($, on, { answer })
  await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'node-b' })
  await clock.settle()
  const bad = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/
  const rows = await ui.findAll({ type: 'Button' })
  expect(rows).toHaveLength(2)
  for (const row of rows) expect(String((row as any).props.label)).not.toMatch(bad)
  expect(String((rows[1] as any).props.label)).toContain('from src')
  const texts = await ui.findAll({ type: 'Text' })
  for (const text of texts) expect(String((text as any).text ?? '')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/)
  expect(await ui.find({ type: 'Text', text: /select.*1/s })).toBeDefined()
  await ui.unmount()
})

test('the SQL of a selected node is cut at a limit and says how much was left out', async ($, on) => {
  const answer = {
    nodes: [{ id: 'big', name: 'big', type: 'cte', sql: `${'x'.repeat(20_000)}TAILMARK${'x'.repeat(4_992)}`, columns: [] }],
    edges: [],
  }
  const { clock } = await start($, on, { answer })
  await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'node-big' })
  await clock.settle()
  const shown = await ui.find({ type: 'Text', text: /… 5000 more characters not shown$/ })
  expect(shown).toBeDefined()
  expect(JSON.stringify(shown)).not.toContain('TAILMARK')
  await ui.unmount()
})

test('without a name /sql-graph shows the model Claude last read; with none read it says what to do and calls nothing', async ($, on) => {
  const { clock, cli } = await start($, on)
  const none = await $.command.run({ command: 'sql-graph', args: '', ...composer } as any)
  expect(none.text).toBe('Read or edit a dbt model, or run /sql-graph <model>.')
  expect(cli).toHaveLength(0)

  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  await $.command.run({ command: 'sql-graph', args: '', ...composer } as any)
  await clock.settle()
  expect(cli).toHaveLength(1)
  expect(JSON.parse(cli[0]![cli[0]!.indexOf('--args') + 1]!)).toEqual({ model: 'fct_orders' })
})

test('a tool failure is the pane\'s message and the command\'s reply', async ($, on) => {
  const { clock } = await start($, on, { fail: 'Not available: no dbt project here' })
  const reply = await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  expect(reply.text).toBe('Not available: no dbt project here')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Not available: no dbt project here' })).toBeDefined()
  await ui.unmount()
})

test('an edit to a model adds one line with its CTE count and never calls the backend', async ($, on) => {
  const { clock, cli } = await start($, on, { sql: 'with a as (select 1), b as (select 2) select * from a' })
  const result = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: '1', new_string: '2' })
  await clock.settle()
  expect((result as any).context).toContain('2 CTEs · /sql-graph')
  expect(cli).toHaveLength(0)
})

test('an edit to a model with no CTEs, or to a file that is no model, adds no line', async ($, on) => {
  const { clock } = await start($, on, { sql: 'select 1' })
  const plain = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: '1', new_string: '2' })
  const macro = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/macros/m.sql`, old_string: '1', new_string: '2' })
  await clock.settle()
  expect(JSON.stringify((plain as any).context ?? [])).not.toContain('/sql-graph')
  expect(JSON.stringify((macro as any).context ?? [])).not.toContain('/sql-graph')
})

test('an older ask for the same model that answers after a newer one does not replace it, and says so', async ($, on) => {
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const { clock } = await start($, on, { holdFirst: held })
  const older = $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.advance(3_000)
  expect((await older).text).toBe('The SQL graph for fct_orders is loading; the pane shows it when it is ready.')
  // The second ask answers at once; the first answers after it.
  const newer = await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  expect(newer.text).toBe('The SQL graph for fct_orders is open.')
  release()
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /SQL graph · fct_orders · 3 nodes/ })).toBeDefined()
  await ui.unmount()
})

test('an older ask that answers after a newer one, inside the wait, replies that it was replaced', async ($, on) => {
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const { clock } = await start($, on, { holdFirst: held })
  const older = $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.advance(500)
  const newer = await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  expect(newer.text).toBe('The SQL graph for fct_orders is open.')
  release()
  await clock.settle()
  expect((await older).text).toBe('The SQL graph for fct_orders was replaced by a newer /sql-graph.')
})

test('an answer that lands after a new conversation started is dropped', async ($, on) => {
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const { clock } = await start($, on, { hold: { fct_orders: held } })
  const reply = $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.advance(3_000)
  await reply
  await $.session.end({ sessionId: 'test' } as any)
  release()
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Run /sql-graph <model>.' })).toBeDefined()
  await ui.unmount()
})

test('a tool answer of status ok with success false is the failure it says, not an empty graph', async ($, on) => {
  const { clock } = await start($, on, { ok: false })
  const reply = await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  expect(reply.text).toBe('Not available: this needs the dbt adapter')
})

test('the tool\'s own reason is shown, not the CLI\'s generic output', async ($, on) => {
  const { clock } = await start($, on, { ok: false, okOutput: 'Compiled 1 model in 2.1s' })
  const reply = await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  expect(reply.text).toBe('Not available: this needs the dbt adapter')
})

test('a malformed node or edge from the backend is dropped, and a node without columns is drawn with none', async ($, on) => {
  const answer = {
    nodes: [null, { id: 'a', name: 'a', type: 'cte', sql: 123 }, { id: 5 }],
    edges: [['a'], ['a', 'a']],
  }
  const { clock } = await start($, on, { answer })
  await $.command.run({ command: 'sql-graph', args: 'fct_orders', ...composer } as any)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Button' })).map(row => row.key)).toEqual(['node-a'])
  await ui.press({ key: 'node-a' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '(no SQL)' })).toBeDefined()
  await ui.unmount()
})
