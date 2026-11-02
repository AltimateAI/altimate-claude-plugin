import { expect, mock, test } from 'claude-code/testing'

import { buildGraph, subgraph } from './lineage-graph'
import { MANIFEST } from './lineage-graph.test'

const ROOT = '/repo'
const MANIFEST_PATH = `${ROOT}/target/manifest.json`
const FILE = `${ROOT}/models/fct_orders.sql`

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-lineage',
  props: { title: 'Altimate lineage', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const BAND = {
  plugin: 'altimate-code',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const LINEAGE = {
  model_name: 'fct_orders',
  model_unique_id: 'model.shop.fct_orders',
  confidence: 'high',
  confidence_factors: [],
  upstream: ['model.shop.int_orders', 'model.shop.stg_customers'],
  columns: { order_id: ['"int_orders"."order_id"'], revenue: ['"int_orders"."revenue"'] },
  edges: [
    { source: '"int_orders"."order_id"', target: 'order_id', lineage_type: 'direct', lens_type: 'Original', lens_code: [] },
    { source: '"int_orders"."revenue"', target: 'revenue', lineage_type: 'direct', lens_type: 'Transformation', lens_code: [] },
  ],
}

const LINEAGE_TEXT = [
  'Model: fct_orders',
  '',
  'Column Mappings:',
  '  order_id ← ["\\"int_orders\\".\\"order_id\\""]',
  '',
  'Lineage Edges:',
  `  ${JSON.stringify(LINEAGE.edges[0])}`,
].join('\n')

const REACH = {
  severity: 'MEDIUM',
  column_reach: {
    models: [
      { name: 'fct_revenue_daily', columns: ['revenue'] },
      { name: 'rpt_finance_weekly', columns: ['revenue'] },
    ],
    exposures: [{ name: 'exec_revenue', label: 'Exec Revenue', type: 'dashboard' }],
    truncated: false,
  },
}

type Options = { mcp?: boolean; warehouse?: boolean; structured?: boolean; size?: number; mtime?: () => number; reach?: Record<string, unknown>; capped?: boolean }

/**
 * A dbt project at /repo, the plugin's MCP server (or the CLI when it is not connected), and the
 * session beneath the plugin. Every call the mod makes is recorded in `calls`, in order.
 */
async function start($: any, on: any, options: Options = {}) {
  const { mcp = true, warehouse = false, structured = true, size = 5000, mtime = () => 1, reach = REACH, capped = false } = options
  const clock = mock.clock(on)
  const calls: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  on('command.register', () => ({ value: { command: 'lineage' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.open', () => ({ value: {} }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_: unknown, e: { text: string }) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === `${ROOT}/dbt_project.yml` || e.path === MANIFEST_PATH }))
  on('fs.stat', () => ({ value: { kind: 'file', size, mtimeMs: mtime(), isLink: false } }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: e.path === MANIFEST_PATH ? JSON.stringify(MANIFEST) : 'select 1' }))
  on('tool.list', () => ({
    value: warehouse ? [{ name: 'mcp__altimate_saas__table_lineage', description: 'Snowflake table lineage', mcp: true }] : [],
  }))
  on('mcp.connect', () => ({ value: mcp ? { isConnected: true, server: 'plugin:altimate-code:altimate-code' } : { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('mcp.call', (_: unknown, e: { server: string; tool: string; args?: Record<string, any> }) => {
    calls.push(`mcp:${e.tool}${e.args?.column ? `:${e.args.column}` : ''}`)
    // Claude Code passes structured content on as a JSON text block in place of the text.
    if (e.tool === 'dbt_lineage') {
      const text = structured ? JSON.stringify({ ...LINEAGE, report: LINEAGE_TEXT }) : LINEAGE_TEXT
      return { value: { content: [{ type: 'text', text }], isError: false } }
    }
    // Over its size cap the server sends the report alone, marked truncated.
    if (e.tool === 'impact_analysis') {
      const body = capped ? { report: 'Impact', truncated: true } : { ...reach, report: 'Impact' }
      return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } }
    }
    if (e.tool === 'table_lineage') {
      return {
        value: {
          content: [],
          isError: false,
          structuredContent: { data: { records: [{ source_table: 'shop.main.fct_orders', target_table: 'shop.main.fct_revenue_daily', hop: 1 }] } },
        },
      }
    }
    return { value: { content: [], isError: true } }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [, command, , tool] = e.argv
    // The integrations half of the plugin asks the CLI for its status at session start.
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    const args = JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1] ?? '{}'))
    calls.push(`cli:${tool}${args.include_graph ? ':graph' : ''}`)
    // altimate-code's dbt_lineage with include_graph returns the subgraph the pane would build itself.
    const graph = args.include_graph ? { graph: subgraph(buildGraph(MANIFEST), 'model.shop.fct_orders') } : {}
    const body =
      tool === 'dbt_lineage'
        ? { status: 'ok', output: LINEAGE_TEXT, metadata: args.include_graph ? { ...LINEAGE, ...graph } : { model_name: 'fct_orders', confidence: 'high' } }
        : { status: 'ok', output: '', metadata: reach }
    return { value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '' } }
  })
  // The tool itself, beneath the plugin.
  on('tool.call', (_: unknown, e: { tool: string }) => {
    calls.push(`tool:${e.tool}`)
    return { result: { ok: true } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, calls, toasts, logs }
}

test('reading a model points the pane at it: the manifest graph, then its columns from dbt_lineage', async ($, on) => {
  const { clock, calls, logs } = await start($, on)
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()

  expect(calls).toEqual(['tool:Read', 'mcp:dbt_lineage'])
  expect(logs).toContain('lineage-pane · following fct_orders →')
  expect(logs.some(line => line.startsWith('lineage-pane · target/manifest.json · ') && line.endsWith('offline'))).toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /lineage · fct_orders/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'UPSTREAM · manifest' })).toBeDefined()
  expect(await ui.find({ key: 'up-1-model.shop.int_orders' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5 direct · 1 transitive · 1 tests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /← int_orders\.revenue\s+Transformation/ })).toBeDefined()
  await ui.unmount()
})

test('an edit naming a column is held until its reach is known, then the reach goes to Claude and the band', async ($, on) => {
  const { clock, calls, toasts, logs } = await start($, on)
  const edit = { tool: 'Edit' as const, file_path: FILE, old_string: 'sum(amount) as revenue', new_string: 'sum(amount) - sum(refunds) as revenue' }
  const result: any = await $.tool.call(edit)
  await clock.settle()

  // The reach is looked up before the edit runs.
  expect(calls.indexOf('mcp:impact_analysis:revenue')).toBeLessThan(calls.indexOf('tool:Edit'))
  expect(toasts[0]).toBe('◆ impact-first · fct_orders.revenue is read by 2 models and 1 dashboard · Exec Revenue')
  expect(result.context?.[0]).toContain('read by 2 downstream models: fct_revenue_daily (revenue), rpt_finance_weekly (revenue)')
  expect(result.context?.[0]).toContain('dashboards on them: Exec Revenue')
  expect(logs).toContain("impact-first · added to Claude's context: lineage for fct_orders.revenue")

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: 'fct_orders.revenue' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'MEDIUM' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /direct 5 · transitive 1 · tests 1 · read by 2 models · 1 dashboards/ })).toBeDefined()
  await band.press({ key: 'lineage-dismiss' })
  await clock.settle()
  expect(await band.find({ key: 'lineage-open' })).toBeUndefined()
  await band.unmount()

  // The same column again adds nothing new to Claude's context.
  const again: any = await $.tool.call(edit)
  await clock.settle()
  expect(again.context ?? []).toEqual([])
})

test('[c] picks a column and shows its reach; [d] unfolds downstream; a model in the graph is followed on press', async ($, on) => {
  const { clock, calls } = await start($, on)
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /2 more models/ })).toBeDefined()
  await ui.press({ key: 'lineage-down' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /2 more models/ })).toBeUndefined()

  await ui.press({ key: 'lineage-column' })
  await clock.settle()
  await ui.press({ key: 'lineage-column' })
  await clock.settle()
  expect(calls).toContain('mcp:impact_analysis:revenue')
  expect(await ui.find({ type: 'Text', text: 'COLUMN · revenue' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /read by 2 models · 1 dashboards/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Exec Revenue' })).toBeDefined()

  await ui.press({ key: 'up-1-model.shop.int_orders' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /lineage · int_orders/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'COLUMN · revenue' })).toBeUndefined()
  await ui.unmount()
})

test('without the MCP server the CLI answers, and dbt_lineage text from an older build still parses', async ($, on) => {
  const { clock, calls } = await start($, on, { mcp: false })
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  expect(calls).toEqual(['tool:Read', 'cli:dbt_lineage'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /← int_orders\.order_id\s+Original/ })).toBeDefined()
  await ui.unmount()
})

test('a connected SaaS table_lineage tool adds what the warehouse has observed', async ($, on) => {
  const { clock, calls } = await start($, on, { warehouse: true })
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  expect(calls).toContain('mcp:table_lineage')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'OBSERVED IN THE WAREHOUSE · altimate_saas' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'hop 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'not seen in the warehouse' })).toBeDefined()
  await ui.unmount()
})

test("Claude's own dbt_lineage result is drawn as a colored edge list, with the original under it on ctrl+o", async ($, on) => {
  await start($, on)
  const row = {
    plugin: 'altimate-code',
    component: 'ToolResult',
    requestId: 'tu-1',
    props: { tool_use_id: 'tu-1', tool: 'mcp__plugin_altimate-code_altimate-code__dbt_lineage', output: [{ type: 'text', text: LINEAGE_TEXT }], isErrored: false },
  } as const
  const ui = await $.ui.mount({ ...row, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /fct_orders · confidence high · 1 columns · 1 edges/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Original' })).toBeDefined()
  await ui.unmount()
  // ctrl+o keeps the original output under the list.
  const full = await $.ui.mount({ ...row, props: { ...row.props, isExpanded: true }, surface: 'terminal' } as any)
  expect(await full.find({ type: 'Text', text: /confidence high/ })).toBeDefined()
  expect(await full.find({ key: 'engine' })).toBeDefined()
  await full.unmount()
})

test('/lineage names a model and column; an unknown model says so', async ($, on) => {
  const { clock, calls } = await start($, on)
  const run = (args: string) =>
    $.command.run({ command: 'lineage', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect((await run('fct_orders.revenue')).text).toContain('fct_orders.revenue')
  await clock.settle()
  expect(calls).toContain('mcp:impact_analysis:revenue')

  await run('nope')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No dbt model matches "nope"/ })).toBeDefined()
  await ui.unmount()
})

test('a manifest over 4 MiB is read through altimate-code: the graph comes from dbt_lineage with include_graph', async ($, on) => {
  const { clock, calls, toasts } = await start($, on, { size: 6 * 1024 * 1024 })
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  expect(calls).toEqual(['tool:Read', 'cli:dbt_lineage:graph'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'UPSTREAM · altimate-code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5 direct · 1 transitive · 1 tests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /← int_orders\.revenue\s+Transformation/ })).toBeDefined()
  await ui.unmount()

  // Impact-first works on the same path.
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'x as revenue', new_string: 'y as revenue' })
  await clock.settle()
  expect(toasts[0]).toContain('fct_orders.revenue is read by 2 models')
})

test('a recompiled manifest is a new focus: the column lineage is read again', async ($, on) => {
  let mtime = 1
  const { clock, calls } = await start($, on, { mtime: () => mtime })
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  expect(calls.filter(call => call === 'mcp:dbt_lineage')).toHaveLength(1)
  mtime = 2
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  expect(calls.filter(call => call === 'mcp:dbt_lineage')).toHaveLength(2)
})

test('a subagent gets the lineage context the main agent already got, and an untraced model keeps the count a lower bound', async ($, on) => {
  const reach = { ...REACH, column_reach: { ...REACH.column_reach, untraced: [{ name: 'mart_cohort_ltv', reason: 'No compiled SQL found' }], uncertain: [] } }
  const { clock, toasts } = await start($, on, { reach })
  const edit = { tool: 'Edit' as const, file_path: FILE, old_string: 'x as revenue', new_string: 'y as revenue' }
  const main: any = await $.tool.call(edit)
  const sub: any = await $.tool.call({ ...edit, agentId: 'sub-1' } as any)
  await clock.settle()
  expect(toasts[0]).toContain('is read by at least 2 models')
  expect(main.context?.[0]).toContain('could not be traced: mart_cohort_ltv (No compiled SQL found)')
  expect(sub.context?.[0]).toContain('read by at least 2 downstream models')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /read by at least 2 models/ })).toBeDefined()
  await band.unmount()
})

test('a read Claude makes outside a dbt project stays quiet', async ($, on) => {
  const { clock, calls } = await start($, on)
  await $.tool.call({ tool: 'Read', file_path: '/elsewhere/query.sql' })
  await clock.settle()
  expect(calls).toEqual(['tool:Read'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Not inside a dbt project/ })).toBeUndefined()
  await ui.unmount()
})

test('a result the MCP server left out for size is fetched again through the CLI', async ($, on) => {
  const { clock, calls } = await start($, on, { capped: true })
  const run = (args: string) =>
    $.command.run({ command: 'lineage', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await run('fct_orders.revenue')
  await clock.settle()
  expect(calls).toContain('mcp:impact_analysis:revenue')
  expect(calls).toContain('cli:impact_analysis')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /read by 2 models · 1 dashboards/ })).toBeDefined()
  await ui.unmount()
})

test("following Claude's own dbt_lineage call uses the manifest it named", async ($, on) => {
  const { clock } = await start($, on)
  await $.tool.call({ tool: 'mcp__plugin_altimate-code_altimate-code__dbt_lineage', manifest_path: 'target/manifest.json', model: 'int_orders' } as any)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /lineage · int_orders/ })).toBeDefined()
  await ui.unmount()
})
