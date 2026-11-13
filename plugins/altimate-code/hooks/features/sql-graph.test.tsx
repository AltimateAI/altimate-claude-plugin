import { expect, mock, test } from 'claude-code/testing'

import { cteCount, inputsOf, modelOfPath, orderNodes } from './sql-graph'

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
    { name: 'fct_orders', type: 'model', nodeId: 'model.shop.fct_orders', sql: 'select * from paid', columns: [{ name: 'order_id' }, { name: 'amount' }] },
    { name: 'paid', type: 'cte', sql: 'select order_id, amount\nfrom orders\nwhere status = \'paid\'', columns: [{ name: 'order_id' }, { name: 'amount' }] },
    { name: 'orders', type: 'model', nodeId: 'model.shop.stg_orders', sql: '', columns: [{ name: 'order_id' }, { name: 'amount' }, { name: 'status' }] },
  ],
  edges: [
    ['orders', 'paid'],
    ['paid', 'fct_orders'],
  ],
}

type Options = { answer?: Record<string, unknown>; fail?: string; sql?: string }

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
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    reads.push(e.path)
    return { value: options.sql ?? 'select 1' }
  })
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [, command] = e.argv
    // The integrations half of the plugin asks the CLI for its status at session start.
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    cli.push([...e.argv])
    if (options.fail) return { value: { exitCode: 1, stdout: JSON.stringify({ status: 'error', output: options.fail, metadata: { success: false } }), stderr: '' } }
    const metadata = { success: true, model: 'fct_orders', ...(options.answer ?? GRAPH) }
    return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: 'SQL graph for fct_orders', metadata }), stderr: '' } }
  })
  on('tool.call', () => ({ result: { ok: true } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, cli, reads }
}

const composer = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

test('orderNodes puts each node after what feeds it, whatever order the backend listed them in', () => {
  expect(orderNodes(GRAPH as any).map(node => node.name)).toEqual(['orders', 'paid', 'fct_orders'])
  expect(inputsOf(GRAPH as any, 'fct_orders')).toEqual(['paid'])
  expect(inputsOf(GRAPH as any, 'orders')).toEqual([])
})

test('orderNodes keeps the listed order for nodes with no edges and survives a cycle', () => {
  const alone = { nodes: [{ name: 'b' }, { name: 'a' }], edges: [] } as any
  expect(orderNodes(alone).map(node => node.name)).toEqual(['b', 'a'])
  const cycle = { nodes: [{ name: 'a' }, { name: 'b' }], edges: [['a', 'b'], ['b', 'a']] } as any
  expect(orderNodes(cycle).map(node => node.name).sort()).toEqual(['a', 'b'])
})

test('modelOfPath names a model by its file and leaves out macros, tests, snapshots and build output', () => {
  expect(modelOfPath('/repo/models/marts/fct_orders.sql')).toBe('fct_orders')
  expect(modelOfPath('C:\\repo\\models\\fct_orders.SQL')).toBe('fct_orders')
  expect(modelOfPath('/repo/macros/cents.sql')).toBeNull()
  expect(modelOfPath('/repo/target/compiled/shop/models/a.sql')).toBeNull()
  expect(modelOfPath('/repo/models/schema.yml')).toBeNull()
})

test('cteCount counts the CTEs a model defines, not words in comments or strings', () => {
  expect(cteCount('with a as (select 1), b as (select 2), "c" as (select 3) select * from a')).toBe(3)
  expect(cteCount('with recursive r as (select 1) select * from r')).toBe(1)
  expect(cteCount("-- with x as (\nselect ', y as (' as s from t")).toBe(0)
  expect(cteCount('select cast(a as int), b as c from t')).toBe(0)
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
  expect(await ui.find({ type: 'Button', label: /orders \(model\) · 3 columns$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: /paid \(cte\) · 2 columns · from orders$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: /fct_orders \(model\) · 2 columns · from paid$/ })).toBeDefined()
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
  expect((plain as any).context ?? []).not.toContain('0 CTEs · /sql-graph')
  expect(JSON.stringify((plain as any).context ?? [])).not.toContain('/sql-graph')
  expect(JSON.stringify((macro as any).context ?? [])).not.toContain('/sql-graph')
})
