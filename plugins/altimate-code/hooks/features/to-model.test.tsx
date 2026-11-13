import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/repo'
const SQL = 'select o.id, c.name from analytics.public.orders o join "PUBLIC"."CUSTOMERS" c on c.id = o.customer_id join raw.events e on e.id = o.id'

const MAPPINGS = [
  { raw: 'analytics.public.orders', replaceWith: "{{ ref('orders') }}", match: 'exact', candidates: [{ replaceWith: "{{ ref('orders') }}", kind: 'model', name: 'orders', relationName: '"analytics"."public"."orders"', match: 'exact' }] },
  { raw: '"PUBLIC"."CUSTOMERS"', replaceWith: "{{ source('shop', 'customers') }}", match: 'partial', candidates: [{ replaceWith: "{{ source('shop', 'customers') }}", kind: 'source', name: 'customers', relationName: '"analytics"."public"."customers"', match: 'partial' }] },
  { raw: 'raw.events', replaceWith: 'raw.events', match: 'none', candidates: [] },
]

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-to-model',
  props: { title: 'Raw SQL to dbt model', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Setup = { mappings?: unknown; selection?: string | null; cli?: { exitCode: number; stdout: string } }

/** A session with a CLI that answers dbt_map_relations, a file at /repo/q.sql, and the prompts the mod submits. */
async function start($: any, on: any, setup: Setup = {}) {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const cliArgs: Record<string, unknown>[] = []
  on('command.register', () => ({ value: { command: 'to-model' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: {} }))
  on('ui.selection', () => ({ value: setup.selection === undefined || setup.selection === null ? undefined : { text: setup.selection } }))
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path === `${ROOT}/q.sql`) return { value: SQL }
    if (e.path === `${ROOT}/empty.sql`) return { value: '  \n' }
    throw new Error('ENOENT')
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    if (e.argv[3] === 'dbt_map_relations') cliArgs.push(JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1])))
    const answer = setup.cli ?? {
      exitCode: 0,
      stdout: JSON.stringify({ status: 'ok', output: 'mapped', metadata: { success: true, dialect: 'snowflake', mappings: setup.mappings ?? MAPPINGS } }),
    }
    return { value: { stderr: '', ...answer } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, prompts, cliArgs }
}

const run = ($: any, args: string) => $.command.run({ command: 'to-model', args } as any)

test('the file is mapped and one instruction carries exactly the replacements, asking before sources for unmatched tables', async ($, on) => {
  const { clock, prompts, cliArgs } = await start($, on)
  const reply = await run($, 'fct_orders q.sql')
  await clock.settle()

  expect(cliArgs).toEqual([{ sql: SQL }])
  expect(reply.text).toBe('3 tables: 2 matched, 1 unmatched, 1 partial. Asked Claude to write models/<layer>/fct_orders.sql.')
  expect(prompts).toEqual([
    [
      'Convert the raw SQL in q.sql into the dbt model "fct_orders": write models/<layer>/fct_orders.sql, choosing <layer> from the folders and naming this project already uses.',
      '',
      'Replace each table with exactly these ref() and source() calls, nothing else:',
      "  \"PUBLIC\".\"CUSTOMERS\" -> {{ source('shop', 'customers') }} (partial match: the SQL names fewer parts than the relation; confirm with me if the schema differs)",
      "  analytics.public.orders -> {{ ref('orders') }}",
      '',
      'These tables match no model or source: raw.events.',
      'Ask me before adding a source for them, and leave them as written until I answer.',
      '',
      'Keep the rest of the query as it is, then run dbt compile on the new model.',
      '',
      '```sql',
      SQL,
      '```',
    ].join('\n'),
  ])
})

test('the pane lists unmatched rows first, then partial, then matched', async ($, on) => {
  const { clock } = await start($, on)
  await run($, 'fct_orders q.sql')
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map((one: { text?: string }) => one.text ?? '')
  const row = (needle: RegExp) => texts.findIndex(text => needle.test(text))
  expect(row(/✗ raw\.events → no model or source/)).toBeGreaterThan(-1)
  expect(row(/✗ raw\.events/)).toBeLessThan(row(/~ "PUBLIC"\."CUSTOMERS"/))
  expect(row(/~ "PUBLIC"\."CUSTOMERS"/)).toBeLessThan(row(/✓ analytics\.public\.orders → \{\{ ref\('orders'\) \}\}/))
  expect(texts.some(text => /Needs a decision/.test(text))).toBe(true)
  await ui.unmount()
})

test('without a path the selection is the SQL; with neither, the reply says what to do', async ($, on) => {
  const selected = await start($, on, { selection: 'select 1 from raw.events', mappings: [MAPPINGS[2]] })
  const reply = await run($, 'stg_events')
  await selected.clock.settle()
  expect(selected.cliArgs).toEqual([{ sql: 'select 1 from raw.events' }])
  expect(reply.text).toContain('1 table: 0 matched, 1 unmatched')
  expect(selected.prompts[0]).toContain('Convert the raw SQL I selected into the dbt model "stg_events"')
  expect(selected.prompts[0]).toContain('  (none matched)')
})

test('no SQL, a bad name, an unreadable or empty file ask for nothing and submit nothing', async ($, on) => {
  const { prompts, cliArgs } = await start($, on)
  expect((await run($, '')).text).toContain('Usage: /to-model')
  expect((await run($, '9bad q.sql')).text).toContain('"9bad" is not a dbt model name')
  expect((await run($, 'm')).text).toContain('No SQL: pass a file path or select the SQL first.')
  expect((await run($, 'm missing.sql')).text).toBe('Could not read missing.sql.')
  expect((await run($, 'm empty.sql')).text).toBe('empty.sql is empty.')
  expect(prompts).toEqual([])
  expect(cliArgs).toEqual([])
})

test('a CLI without the tool is told to upgrade and nothing is submitted', async ($, on) => {
  const missing = await start($, on, { cli: { exitCode: 1, stdout: JSON.stringify({ status: 'error', output: 'Error: unknown tool: dbt_map_relations' }) } })
  expect((await run($, 'm q.sql')).text).toContain('needs a newer altimate-code')
  expect(missing.prompts).toEqual([])
})

test('a tool error is reported by its first line, and a query with no tables maps nothing', async ($, on) => {
  const failed = await start($, on, { cli: { exitCode: 1, stdout: JSON.stringify({ status: 'error', output: 'No manifest at /repo/target/manifest.json.\nRun dbt parse.' }) } })
  expect((await run($, 'm q.sql')).text).toBe('/to-model could not map the tables: No manifest at /repo/target/manifest.json.')
  expect(failed.prompts).toEqual([])
})

test('a query with no tables submits nothing', async ($, on) => {
  const none = await start($, on, { mappings: [] })
  expect((await run($, 'm q.sql')).text).toBe('No tables found in that SQL: nothing to map to ref() or source().')
  expect(none.prompts).toEqual([])
})
