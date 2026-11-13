import { expect, mock, test } from 'claude-code/testing'

import { applyPrompt, candidatesFrom, changedDescriptions, columnDescriptions, modelPaths } from './docs'

const ROOT = '/repo'
const MANIFEST_PATH = `${ROOT}/target/manifest.json`
const SCHEMA = `${ROOT}/models/staging/schema.yml`

const BEFORE = `version: 2
models:
  - name: stg_orders
    description: One row per order
    columns:
      - name: customer_id
        description: ""
        data_tests:
          - not_null
      - name: order_id
        description: The order key
  - name: stg_customers
    columns:
      - name: customer_id
`

const AFTER = `version: 2
models:
  - name: stg_orders
    description: One row per order
    columns:
      - name: customer_id
        description: "The customer's key, as the shop issues it"
        data_tests:
          - not_null
      - name: order_id
        description: The order key
  - name: stg_customers
    columns:
      - name: customer_id
`

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-docs',
  props: { title: 'Altimate docs', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const BAND = {
  plugin: 'altimate-code',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const REACH = {
  severity: 'LOW',
  column_reach: {
    models: [
      { name: 'fct_orders', unique_id: 'model.shop.fct_orders', columns: ['customer_id'], lens_types: { customer_id: 'Original' } },
      { name: 'dim_customers', unique_id: 'model.shop.dim_customers', columns: ['id', 'order_count'], lens_types: { id: 'Alias', order_count: 'Transformation' } },
      { name: 'rpt_ltv', unique_id: 'model.shop.rpt_ltv', columns: ['spend'], lens_types: { spend: 'Not sure' } },
    ],
    exposures: [],
    truncated: false,
  },
}

test('a column description is read from block, quoted, folded and literal YAML', () => {
  const yaml = `models:
  - name: m
    columns:
      - name: a
        description: plain text # a comment
      - name: b
        description: 'it''s quoted'
      - name: c
        description: >
          folded
          over lines
      - name: d
        description: |
          literal
          lines
      - name: e
      - name: f
        description: runs on
          over a second line
sources:
  - name: raw
    tables:
      - name: t
        columns:
          - name: z
            description: not a model column
`
  expect([...columnDescriptions(yaml)]).toEqual([
    ['m.a', 'plain text'],
    ['m.b', "it's quoted"],
    ['m.c', 'folded over lines'],
    ['m.d', 'literal lines'],
    ['m.f', 'runs on over a second line'],
  ])
})

test('a model description is not a column description, and a column of another model is its own', () => {
  const found = columnDescriptions(AFTER)
  expect(found.get('stg_orders.customer_id')).toBe("The customer's key, as the shop issues it")
  expect(found.has('stg_orders.stg_orders')).toBe(false)
  expect(found.has('stg_customers.customer_id')).toBe(false)
  expect([...found.keys()]).toEqual(['stg_orders.customer_id', 'stg_orders.order_id'])
})

test('only new or changed descriptions are reported; a new file reports all of them', () => {
  expect(changedDescriptions(BEFORE, AFTER)).toEqual([{ model: 'stg_orders', column: 'customer_id', description: "The customer's key, as the shop issues it" }])
  expect(changedDescriptions(AFTER, AFTER)).toEqual([])
  expect(changedDescriptions(null, AFTER).map(one => one.column)).toEqual(['customer_id', 'order_id'])
})

test('model folders come from dbt_project.yml, in either list style, else models', () => {
  expect(modelPaths("name: shop\nmodel-paths: ['models', \"more/models\"]\n")).toEqual(['models', 'more/models'])
  expect(modelPaths('name: shop\nmodel-paths:\n  - sql\n  - "other"\ntest-paths: ["t"]\n')).toEqual(['sql', 'other'])
  expect(modelPaths('name: shop\n')).toEqual(['models'])
})

test('only Original and Alias columns are candidates; a calculation and an unsure column are not', () => {
  const { candidates, unrated } = candidatesFrom(REACH)
  expect(candidates).toEqual([
    { model: 'fct_orders', id: 'model.shop.fct_orders', column: 'customer_id', lens: 'Original' },
    { model: 'dim_customers', id: 'model.shop.dim_customers', column: 'id', lens: 'Alias' },
  ])
  expect(unrated).toBe(false)
})

test('a reach with no ratings offers nothing and says it is unrated', () => {
  const old = { column_reach: { models: [{ name: 'fct_orders', columns: ['customer_id'] }] } }
  expect(candidatesFrom(old)).toEqual({ candidates: [], unrated: true })
  expect(candidatesFrom({ column_reach: { models: [] } })).toEqual({ candidates: [], unrated: false })
  expect(candidatesFrom(null)).toEqual({ candidates: [], unrated: false })
})

test('the request lists each description with only the columns left ticked', () => {
  const group = {
    model: 'stg_orders',
    column: 'customer_id',
    description: 'The key',
    manifest: MANIFEST_PATH,
    candidates: [
      { model: 'fct_orders', column: 'customer_id', lens: 'Original' as const },
      { model: 'dim_customers', column: 'id', lens: 'Alias' as const },
    ],
  }
  const text = applyPrompt([group], ['stg_orders.customer_id>fct_orders.customer_id'])!
  expect(text).toContain('stg_orders.customer_id is described as: "The key"')
  expect(text).toContain('- dim_customers.id (renamed from it)')
  expect(text).not.toContain('fct_orders.customer_id')
  expect(applyPrompt([group], ['stg_orders.customer_id>fct_orders.customer_id', 'stg_orders.customer_id>dim_customers.id'])).toBeNull()
})

type Options = { reach?: Record<string, unknown>; coverage?: Record<string, unknown> | null; noManifest?: boolean }

/** A dbt project at /repo with the plugin's MCP server connected, and the session beneath the plugin. */
async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on)
  const calls: string[] = []
  const submitted: string[] = []
  let schemaReads = 0
  on('command.register', () => ({ value: { command: 'propagate' } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.open', () => ({ value: {} }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === `${ROOT}/dbt_project.yml` || (!options.noManifest && e.path === MANIFEST_PATH) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path === `${ROOT}/dbt_project.yml`) return { value: "name: 'shop'\n" }
    // The edit's text from before is read first, then the file as the edit left it.
    if (e.path === SCHEMA) return { value: schemaReads++ === 0 ? BEFORE : AFTER }
    return { value: 'select 1' }
  })
  on('tool.list', () => ({ value: [] }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:altimate-code:altimate-code' } }))
  on('mcp.call', (_: unknown, e: { tool: string; args?: Record<string, any> }) => {
    calls.push(`mcp:${e.tool}${e.args?.column ? `:${e.args.column}` : ''}`)
    if (e.tool === 'impact_analysis') return { value: { content: [{ type: 'text', text: JSON.stringify({ ...(options.reach ?? REACH), report: 'Impact' }) }], isError: false } }
    return { value: { content: [], isError: true } }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [, command, , tool] = e.argv
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    calls.push(`cli:${tool}`)
    if (tool === 'dbt_docs_coverage') {
      const body = options.coverage === null ? { status: 'error', output: 'Unknown tool: dbt_docs_coverage', metadata: {} } : { status: 'ok', output: 'coverage', metadata: options.coverage }
      return { value: { exitCode: options.coverage === null ? 1 : 0, stdout: JSON.stringify(body), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: options.reach ?? REACH }), stderr: '' } }
  })
  on('tool.call', () => ({ result: { ok: true } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, calls, submitted }
}

const EDIT = { tool: 'Edit' as const, file_path: SCHEMA, old_string: 'description: ""', new_string: "description: \"The customer's key, as the shop issues it\"" }

test('a written description is traced, only Original and Alias columns are offered, in a line, the band and the pane', async ($, on) => {
  const { clock, calls, submitted } = await start($, on)
  const result: any = await $.tool.call(EDIT)
  await clock.settle()

  expect(calls).toContain('mcp:impact_analysis:customer_id')
  expect(result.context).toContain('◆ docs · customer_id: 2 downstream columns can take this description · /propagate (fct_orders.customer_id, dim_customers.id)')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await band.find({ type: 'Text', text: /2 downstream columns can take this description · \/propagate/ })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Button', text: /\[x\] fct_orders\.customer_id \(as is\)/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: /\[x\] dim_customers\.id \(renamed\)/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: /order_count/ })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: /spend/ })).toBeUndefined()

  // Unticking one column leaves the other for Apply, which sends one request naming it.
  await pane.press({ key: 'docs-pick-stg_orders.customer_id>fct_orders.customer_id' })
  await clock.settle()
  await pane.press({ key: 'docs-apply' })
  await clock.settle()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('- dim_customers.id (renamed from it)')
  expect(submitted[0]).not.toContain('fct_orders.customer_id')
  await pane.unmount()

  // Applied: nothing is left to offer.
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await after.find({ type: 'Text', text: /can take this description/ })).toBeUndefined()
  await after.unmount()
})

test('an edit that writes no new description traces nothing', async ($, on) => {
  const { clock, calls } = await start($, on)
  // The file reads the same before and after: no description changed.
  const same = { ...EDIT, file_path: `${ROOT}/models/staging/other.yml` }
  const result: any = await $.tool.call(same)
  await clock.settle()
  expect(calls.filter(call => call.includes('impact_analysis'))).toEqual([])
  expect(result.context ?? []).toEqual([])
})

test('a reach without ratings, as an older altimate-code sends, is said once and offers nothing', async ($, on) => {
  const old = { severity: 'LOW', column_reach: { models: [{ name: 'fct_orders', columns: ['customer_id'] }], exposures: [] } }
  const { clock } = await start($, on, { reach: old })
  const result: any = await $.tool.call(EDIT)
  await clock.settle()
  expect(result.context).toHaveLength(1)
  expect(result.context[0]).toContain('needs a release newer than 0.12.10')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await band.find({ type: 'Text', text: /can take this description/ })).toBeUndefined()
  await band.unmount()
})

test('after a model SQL edit its coverage is shown with the columns that have no description', async ($, on) => {
  const coverage = { success: true, model: 'stg_orders', has_description: true, output_columns: ['order_id', 'customer_id', 'status'], documented: ['order_id'], missing: ['customer_id', 'status'], percent: 33.3 }
  const { clock, calls } = await start($, on, { coverage })
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/models/staging/stg_orders.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(calls).toContain('cli:dbt_docs_coverage')
  expect(result.context).toContain('◆ docs · stg_orders: 1 of 3 columns documented (33.3%) · no description for: customer_id, status · as of the last dbt compile')
})

test('an altimate-code without dbt_docs_coverage is said once, not on every edit', async ($, on) => {
  const { clock } = await start($, on, { coverage: null })
  const edit = { tool: 'Edit' as const, file_path: `${ROOT}/models/staging/stg_orders.sql`, old_string: 'a', new_string: 'b' }
  const first: any = await $.tool.call(edit)
  await clock.settle()
  expect(first.context).toHaveLength(1)
  expect(first.context[0]).toContain('no dbt_docs_coverage')
  const second: any = await $.tool.call(edit)
  await clock.settle()
  expect(second.context ?? []).toEqual([])
})

test('a SQL file outside the project\'s model folders is left alone', async ($, on) => {
  const { clock, calls } = await start($, on)
  const result: any = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/macros/helper.sql`, old_string: 'a', new_string: 'b' })
  await clock.settle()
  expect(calls.filter(call => call.includes('dbt_docs_coverage'))).toEqual([])
  expect(result.context ?? []).toEqual([])
})
