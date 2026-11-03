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

type Options = { mcp?: boolean; warehouse?: boolean; structured?: boolean; size?: number; mtime?: () => number; reach?: Record<string, unknown>; capped?: boolean; lineageText?: string; toolResult?: (e: { tool: string }) => unknown; failColumn?: string; holdFirstManifestRead?: Promise<void>; holdReach?: { column: string; until: Promise<void> }; modelLineage?: Record<string, unknown>; cliTooLarge?: boolean; cliFailure?: boolean }

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
  let held = false
  on('fs.read', async (_: unknown, e: { path: string }) => {
    // A test can pause the first manifest read to make one follow resolve after a newer one.
    if (e.path === MANIFEST_PATH && options.holdFirstManifestRead && !held) {
      held = true
      await options.holdFirstManifestRead
    }
    return { value: e.path === MANIFEST_PATH ? JSON.stringify(MANIFEST) : 'select 1' }
  })
  on('tool.list', () => ({
    value: warehouse ? [{ name: 'mcp__altimate_saas__table_lineage', description: 'Snowflake table lineage', mcp: true }] : [],
  }))
  on('mcp.connect', () => ({ value: mcp ? { isConnected: true, server: 'plugin:altimate-code:altimate-code' } : { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('mcp.call', (_: unknown, e: { server: string; tool: string; args?: Record<string, any> }) => {
    calls.push(`mcp:${e.tool}${e.args?.column ? `:${e.args.column}` : ''}`)
    // Claude Code passes structured content on as a JSON text block in place of the text.
    if (e.tool === 'dbt_lineage') {
      // With the dbt integration, the structured result is its model lineage, plus the report.
      if (options.modelLineage) return { value: { content: [{ type: 'text', text: JSON.stringify({ ...options.modelLineage, report: 'Model: fct_orders' }) }], isError: false } }
      const text = options.lineageText ?? (structured ? JSON.stringify({ ...LINEAGE, report: LINEAGE_TEXT }) : LINEAGE_TEXT)
      return { value: { content: [{ type: 'text', text }], isError: false } }
    }
    // Over its size cap the server sends the report alone, marked truncated.
    if (e.tool === 'impact_analysis' && e.args?.column === options.failColumn) return { value: { content: [{ type: 'text', text: 'boom' }], isError: true } }
    if (e.tool === 'impact_analysis' && options.holdReach && e.args?.column === options.holdReach.column) {
      // The held column answers late, and with a reader of its own, so a stale write would show.
      return options.holdReach.until.then(() => ({
        value: { content: [{ type: 'text', text: JSON.stringify({ severity: 'LOW', column_reach: { models: [{ name: 'stale_reader', columns: [] }], exposures: [] }, report: 'x' }) }], isError: false },
      }))
    }
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
    if (options.cliFailure) return { value: { exitCode: 1, stdout: JSON.stringify({ status: 'error', output: 'the dbt project could not start', metadata: {} }), stderr: '' } }
    if (options.cliTooLarge) return { value: { exitCode: 0, stdout: '{"status":"ok","out', stderr: '', isStdoutTruncated: true } }
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
    return { result: options.toolResult?.(e) ?? { ok: true } }
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
  expect(await ui.find({ type: 'Text', text: /GRAPH · manifest · ↑2 ↓2/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /int_orders/ })).toBeDefined()
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
  // The text lists: graph → ends only → folders → list.
  for (let i = 0; i < 3; i++) await ui.press({ key: 'lineage-view' })
  await clock.settle()
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

test('the graph view draws boxes a press follows; [v] cycles the views and [l] the levels; a narrow pane gets the lists', async ($, on) => {
  const { clock } = await start($, on)
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /┏━+┓/ })).toBeDefined()
  await ui.press({ key: 'lineage-levels' })
  await ui.press({ key: 'lineage-up-levels' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /GRAPH · manifest · ↑3 ↓3/ })).toBeDefined()
  for (const title of [/ENDS ONLY · manifest/, /FOLDERS · manifest/, 'UPSTREAM · manifest', /GRAPH · manifest/]) {
    await ui.press({ key: 'lineage-view' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
  }
  const box = await ui.find({ type: 'Button', text: /int_orders/ })
  await ui.press({ key: box!.key! })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /lineage · int_orders/ })).toBeDefined()
  await ui.unmount()

  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: 'UPSTREAM · manifest' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /GRAPH/ })).toBeUndefined()
  await narrow.unmount()
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
  expect(await ui.find({ type: 'Text', text: /GRAPH · altimate-code/ })).toBeDefined()
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

test("a dbt_lineage result Claude's call got cut for size leaves the pane to fetch the columns itself", async ($, on) => {
  const row = { tool: 'mcp__plugin_altimate-code_altimate-code__dbt_lineage', manifest_path: 'target/manifest.json', model: 'fct_orders' }
  // The report alone, with no mappings in it: nothing known about the columns.
  const cut = [{ type: 'text', text: JSON.stringify({ report: 'Model: fct_orders\nID: model.shop.fct_orders', truncated: true }) }]
  const { clock, calls } = await start($, on, { toolResult: e => (e.tool === row.tool ? cut : undefined) })
  await $.tool.call(row as any)
  await clock.settle()
  expect(calls).toContain('mcp:dbt_lineage')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /← int_orders\.revenue\s+Transformation/ })).toBeDefined()
  await ui.unmount()
})

test('dashboards on models that may read the column are counted and named', async ($, on) => {
  const reach = { ...REACH, column_reach: { ...REACH.column_reach, uncertain: [{ name: 'rpt_ops', reason: 'names it only outside its select list' }], uncertain_exposures: [{ name: 'ops', label: 'Ops Board' }] } }
  const { clock, toasts } = await start($, on, { reach })
  const edit: any = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'x as revenue', new_string: 'y as revenue' })
  await clock.settle()
  expect(toasts[0]).toBe('◆ impact-first · fct_orders.revenue is read by at least 2 models and 2 dashboards · Exec Revenue · Ops Board')
  expect(edit.context?.[0]).toContain('dashboards on models that may read it: Ops Board')
})

test('/lineage on the same model with another column traces that column', async ($, on) => {
  const { clock, calls } = await start($, on)
  const run = (args: string) =>
    $.command.run({ command: 'lineage', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await run('fct_orders.revenue')
  await clock.settle()
  await run('fct_orders.order_id')
  await clock.settle()
  expect(calls).toContain('mcp:impact_analysis:order_id')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'COLUMN · order_id' })).toBeDefined()
  await ui.unmount()
})

test('the impact toast shows before the edit runs', async ($, on) => {
  const { clock, toasts } = await start($, on, { toolResult: e => (e.tool === 'Edit' ? { toastsSoFar: toasts.length } : undefined) })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'x as revenue', new_string: 'y as revenue' })
  await clock.settle()
  expect(result.result).toEqual({ toastsSoFar: 1 })
})

test('an edit touching two columns traces both and reports their combined reach', async ($, on) => {
  const { clock, calls, toasts } = await start($, on)
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'i.revenue, i.order_id', new_string: 'coalesce(i.revenue, 0) as revenue, i.order_id + 0 as order_id' })
  await clock.settle()
  expect(calls).toContain('mcp:impact_analysis:revenue')
  expect(calls).toContain('mcp:impact_analysis:order_id')
  expect(toasts[0]).toContain('fct_orders.')
  expect(toasts[0]).toContain('is read by 2 models and 1 dashboard')
})

test('a touched column whose check fails keeps the combined count a lower bound', async ($, on) => {
  const { clock, toasts } = await start($, on, { failColumn: 'order_id' })
  const edit: any = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'i.revenue, i.order_id', new_string: 'coalesce(i.revenue, 0) as revenue, i.order_id + 0 as order_id' })
  await clock.settle()
  expect(toasts[0]).toContain('fct_orders.revenue is read by at least 2 models')
  expect(edit.context?.[0]).toContain('columns not checked (over the limit or no answer in time): order_id')
})

test('a new unchecked column in the same turn still reaches Claude', async ($, on) => {
  const { clock } = await start($, on, { failColumn: 'order_id' })
  const first: any = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'x as revenue', new_string: 'y as revenue' })
  const second: any = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'i.revenue, i.order_id', new_string: 'coalesce(i.revenue, 0) as revenue, i.order_id + 0 as order_id' })
  await clock.settle()
  expect(first.context?.[0]).toContain('fct_orders.revenue')
  expect(second.context?.[0]).toContain('columns not checked (over the limit or no answer in time): order_id')
})

test('columns beyond the cap are named as unchecked and make the count a lower bound', async ($, on) => {
  const { clock, calls, toasts } = await start($, on)
  const edit: any = await $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'a',
    new_string: 'select order_id + 0 as order_id, revenue + 0 as revenue, gross_revenue + 0 as gross_revenue, status + 0 as status',
  })
  await clock.settle()
  expect(calls.filter(call => call.startsWith('mcp:impact_analysis'))).toHaveLength(3)
  expect(toasts[0]).toContain('is read by at least 2 models')
  expect(edit.context?.[0]).toMatch(/columns not checked \(over the limit or no answer in time\): \w+;/)
})

test('/lineage takes a unique_id or a path whole, and only a trailing column off a model name', async ($, on) => {
  const { clock, calls } = await start($, on)
  const run = (args: string) =>
    $.command.run({ command: 'lineage', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await run('model.shop.fct_orders')
  await clock.settle()
  await run('models/fct_orders.sql')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /lineage · fct_orders/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No dbt model matches/ })).toBeUndefined()
  expect(calls.filter(call => call.startsWith('mcp:impact_analysis'))).toEqual([])
  await ui.unmount()
  await run('model.shop.fct_orders.revenue')
  await clock.settle()
  expect(calls).toContain('mcp:impact_analysis:revenue')
})

test('a dbt_lineage text without lineage is not cached as an empty lineage', async ($, on) => {
  const { clock, calls } = await start($, on, { structured: false, lineageText: 'Error: preview unavailable' })
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  // Nothing was cached, so reading the same model again asks again; a cached empty lineage would not.
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  expect(calls.filter(call => call === 'mcp:dbt_lineage')).toHaveLength(2)
})

test("Claude's truncated dbt_lineage result is not preloaded as the whole lineage", async ($, on) => {
  const { clock, calls } = await start($, on, {
    toolResult: e => (e.tool === 'mcp__altimate_code__dbt_lineage' ? { structuredContent: { ...LINEAGE, truncated: true } } : undefined),
  })
  await $.tool.call({ tool: 'mcp__altimate_code__dbt_lineage', model: 'fct_orders' } as any)
  await clock.settle()
  expect(calls).toContain('mcp:dbt_lineage')
})

for (const [id, preloaded] of [['model.shop.fct_orders', true], ['model.other.fct_orders', false]] as const) {
  test(`Claude's whole dbt_lineage result for ${id} ${preloaded ? 'preloads the pane' : "is another project's model: not preloaded"}`, async ($, on) => {
    const { clock, calls } = await start($, on, {
      toolResult: e => (e.tool === 'mcp__altimate_code__dbt_lineage' ? { structuredContent: { ...LINEAGE, model_unique_id: id } } : undefined),
    })
    await $.tool.call({ tool: 'mcp__altimate_code__dbt_lineage', model: 'fct_orders' } as any)
    await clock.settle()
    expect(calls.includes('mcp:dbt_lineage')).toBe(!preloaded)
  })
}

test("an answer from altimate-code too large to read says so, rather than that the model isn't there", async ($, on) => {
  const { clock } = await start($, on, { size: 6 * 1024 * 1024, cliTooLarge: true })
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /altimate-code failed: dbt_lineage's answer was larger than the 4 MiB a plugin can read/ })).toBeDefined()
  await ui.unmount()
})

test("altimate-code's own failure on a large manifest is shown as a failure, not as no such model", async ($, on) => {
  const { clock } = await start($, on, { size: 6 * 1024 * 1024, cliFailure: true })
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /altimate-code failed: the dbt project could not start/ })).toBeDefined()
  await ui.unmount()
})

test('a failing follow started after a good one does not cancel it', async ($, on) => {
  const { clock } = await start($, on)
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/macros/cents.sql` })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /lineage · fct_orders/ })).toBeDefined()
  await ui.unmount()
})

test('an older follow that resolves after a newer one does not overwrite it', async ($, on) => {
  let release!: () => void
  const { clock } = await start($, on, { holdFirstManifestRead: new Promise<void>(resolve => (release = resolve)) })
  // fct_orders by name first, then int_orders: the second claims the pane; the first, landing later, yields.
  const run = (args: string) => $.command.run({ command: 'lineage', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await run('fct_orders')
  await clock.settle()
  await run('int_orders')
  await clock.settle()
  release()
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /lineage · int_orders/ })).toBeDefined()
  await ui.unmount()
})

test('/lineage <model> with no column clears the selected column', async ($, on) => {
  const { clock } = await start($, on)
  const run = (args: string) => $.command.run({ command: 'lineage', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await run('fct_orders.revenue')
  await clock.settle()
  await run('fct_orders')
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'COLUMN · revenue' })).toBeUndefined()
  await ui.unmount()
})

test('an older column-reach answer does not replace the newer one', async ($, on) => {
  let release!: () => void
  const { clock } = await start($, on, { holdReach: { column: 'revenue', until: new Promise<void>(resolve => (release = resolve)) } })
  const run = (args: string) => $.command.run({ command: 'lineage', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await run('fct_orders.revenue')
  await clock.settle()
  await run('fct_orders.order_id')
  await clock.settle()
  release()
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'COLUMN · order_id' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /stale_reader/ })).toBeUndefined()
  await ui.unmount()
})

test('when the whole lookup runs out of time, a toast says the edit went ahead without lineage', async ($, on) => {
  const { clock, toasts } = await start($, on, { holdFirstManifestRead: new Promise<void>(() => {}) })
  const call = $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'x as revenue', new_string: 'y as revenue' })
  await clock.advance(9_000)
  await call
  await clock.settle()
  expect(toasts).toContain('◆ impact-first · the lineage lookup did not finish in time; the edit went ahead without it')
})

test('a .sql file outside any dbt project gets no timeout toast', async ($, on) => {
  const { clock, toasts } = await start($, on)
  const call = $.tool.call({ tool: 'Edit', file_path: '/elsewhere/migrations/001.sql', old_string: 'a', new_string: 'b' })
  await clock.advance(9_000)
  await call
  await clock.settle()
  expect(toasts).toEqual([])
})

test("the pane reads the dbt integration's model lineage from altimate-code", async ($, on) => {
  const modelLineage = {
    version: 1,
    focus: { uniqueId: 'model.shop.fct_orders', name: 'fct_orders' },
    nodes: [
      { uniqueId: 'model.shop.int_orders', name: 'int_orders', type: 'model', direction: 'upstream', depth: 1, parents: [], columns: [] },
      { uniqueId: 'model.shop.fct_orders', name: 'fct_orders', type: 'model', direction: 'focus', depth: 0, parents: ['model.shop.int_orders'], columns: [{ name: 'revenue' }] },
    ],
    columnLineage: [{ source: ['model.shop.int_orders', 'net'], target: ['model.shop.fct_orders', 'revenue'], type: 'direct', viewsType: 'Alias', viewsCode: [] }],
    confidence: 'high',
    errors: [],
  }
  const { clock } = await start($, on, { modelLineage })
  await $.tool.call({ tool: 'Read', file_path: FILE })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /← int_orders\.net\s+Alias/ })).toBeDefined()
  await ui.unmount()
})

test("Claude's dbt_lineage trace from the dbt integration counts the edges on other models, and a column trace is not kept as the model's columns", async ($, on) => {
  const trace = {
    version: 1,
    focus: { uniqueId: 'model.shop.fct_orders', name: 'fct_orders', column: 'revenue' },
    nodes: [
      { uniqueId: 'model.shop.int_orders', name: 'int_orders', type: 'model', direction: 'upstream', depth: 1, parents: [], columns: [] },
      { uniqueId: 'model.shop.fct_orders', name: 'fct_orders', type: 'model', direction: 'focus', depth: 0, parents: ['model.shop.int_orders'], columns: [] },
      { uniqueId: 'model.shop.rpt', name: 'rpt', type: 'model', direction: 'downstream', depth: 1, parents: ['model.shop.fct_orders'], columns: [] },
    ],
    columnLineage: [
      { source: ['model.shop.int_orders', 'net'], target: ['model.shop.fct_orders', 'revenue'], type: 'direct', viewsType: 'Transformation', viewsCode: ['sum(net)'] },
      { source: ['model.shop.fct_orders', 'revenue'], target: ['model.shop.rpt', 'revenue'], type: 'direct', viewsType: 'Original', viewsCode: [] },
    ],
    confidence: 'high',
    errors: [],
  }
  const tool = 'mcp__plugin_altimate-code_altimate-code__dbt_lineage'
  const { clock, calls } = await start($, on, { toolResult: e => (e.tool === tool ? [{ type: 'text', text: JSON.stringify({ ...trace, report: 'x' }) }] : undefined) })
  await $.tool.call({ tool, model: 'fct_orders', column: 'revenue' } as any)
  await clock.settle()
  // Not preloaded from the one-column trace: the pane asks for the whole model.
  expect(calls).toContain('mcp:dbt_lineage')
  const row = await $.ui.mount({
    plugin: 'altimate-code',
    component: 'ToolResult',
    requestId: 'tu-2',
    props: { tool_use_id: 'tu-2', tool, output: [{ type: 'text', text: JSON.stringify({ ...trace, report: 'x' }) }], isErrored: false },
    surface: 'terminal',
  } as any)
  expect(await row.find({ type: 'Text', text: /\+ 1 edges on other models of the trace/ })).toBeDefined()
  expect(await row.find({ type: 'Text', text: / \(sum\(net\)\)/ })).toBeDefined()
  await row.unmount()
})
