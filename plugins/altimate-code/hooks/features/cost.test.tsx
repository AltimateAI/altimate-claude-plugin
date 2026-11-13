import { expect, mock, test } from 'claude-code/testing'

import { formatBytes, inlineSql } from './cost'

const ROOT = '/repo'
const GIB = 1024 ** 3

type Options = {
  /** What dbt_cost_estimate answers for a model or SQL, by model name or the SQL text. */
  answers?: Record<string, Record<string, unknown> | 'unknown-tool'>
  /** The adapter's answer for everything else. */
  fallback?: Record<string, unknown>
}

/** The session beneath the plugin, a CLI whose dbt_cost_estimate is scripted, and a Bash tool that records what ran. */
async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on)
  const estimates: string[] = []
  const ran: string[] = []
  const statuses: (string | undefined)[] = []
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_: unknown, e: { text?: string }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [, command, , tool] = e.argv
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    expect(tool).toBe('dbt_cost_estimate')
    // The adapter starts the project's dbt: the call must carry write permission.
    expect(e.argv).toContain('--allow-write')
    const args = JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1] ?? '{}'))
    const key = String(args.model ?? args.sql)
    estimates.push(key)
    const answer = options.answers?.[key] ?? options.fallback
    if (answer === 'unknown-tool') {
      return { value: { exitCode: 1, stdout: JSON.stringify({ status: 'error', output: `Unknown tool: ${tool}. Run \`altimate-code tool list\` to see the available tools.`, metadata: {} }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: answer ?? { success: false, error: 'no answer scripted' } }), stderr: '' } }
  })
  // The Bash tool itself, beneath the plugin.
  on('tool.call', (_: unknown, e: { tool: string; command?: string }) => {
    if (e.tool === 'Bash') ran.push(String(e.command))
    return { result: { text: 'ok', isError: false } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, estimates, ran, statuses }
}

const bq = (bytes: number, display: string, maxBytes = bytes) => ({ success: true, supported: true, adapter: 'bigquery', bytes, maxBytes, display })
const OVER = bq(20 * GIB, '20.0 GiB')
const UNDER = bq(2 * GIB, '2.0 GiB')

const bash = (command: string) => ({ tool: 'Bash' as const, command })

test('a model over the limit is refused with its estimate, and the command never runs', async ($, on) => {
  const { clock, estimates, ran } = await start($, on, { answers: { orders: OVER } })
  const result: any = await $.tool.call(bash('dbt run --select orders'))
  await clock.settle()

  expect(estimates).toEqual(['orders'])
  expect(ran).toEqual([])
  expect(result.deny).toBe('≈ 20.0 GiB would be scanned, over the 10.0 GiB limit. Narrow the query, or ask the user to run /allow-scan and then run the same command again.')
})

test('a model under the limit runs, with the estimate in a line under the row', async ($, on) => {
  const { clock, ran } = await start($, on, { answers: { orders: UNDER } })
  const result: any = await $.tool.call(bash('dbt build -s orders'))
  await clock.settle()

  expect(ran).toEqual(['dbt build -s orders'])
  expect(result.context).toEqual(['cost · orders would scan 2.0 GiB'])
})

test('dbt show --inline is estimated from its SQL', async ($, on) => {
  const { clock, estimates } = await start($, on, { answers: { 'select * from big': OVER } })
  const result: any = await $.tool.call(bash(`dbt show --inline "select * from big"`))
  await clock.settle()

  expect(estimates).toEqual(['select * from big'])
  expect(result.deny).toContain('20.0 GiB')
})

test('/allow-scan lets the next held command through once, then the one after is held again', async ($, on) => {
  const { clock, estimates, ran } = await start($, on, { answers: { orders: OVER } })
  expect((await $.tool.call(bash('dbt run -s orders')) as any).deny).toBeDefined()

  const allowed = await $.command.run({ command: 'allow-scan', args: '' } as any)
  expect(allowed.text).toContain('runs once')
  const through: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(through.deny).toBeUndefined()
  expect(through.context).toEqual(['cost · orders would scan 20.0 GiB, over the 10.0 GiB limit: allowed once'])
  expect(ran).toEqual(['dbt run -s orders'])

  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeDefined()
  expect(estimates).toHaveLength(3)
})

test('a selection that is not one plain model passes, saying there is no estimate, and asks nothing', async ($, on) => {
  const { clock, estimates, ran } = await start($, on)
  for (const [command, why] of [
    ['dbt run', 'no model named'],
    ['dbt build -s +orders', 'graph, tag, path or package selector'],
    ['dbt run -s tag:nightly', 'graph, tag, path or package selector'],
    ['dbt run -s a b', 'several selectors'],
  ] as const) {
    const result: any = await $.tool.call(bash(command))
    expect(result.deny).toBeUndefined()
    expect(result.context[0]).toContain('cost · no estimate for this selection')
    expect(result.context[0]).toContain(why)
  }
  await clock.settle()
  expect(estimates).toEqual([])
  expect(ran).toHaveLength(4)
})

test('commands that scan nothing are not looked at', async ($, on) => {
  const { clock, estimates, ran } = await start($, on)
  for (const command of ['dbt test -s orders', 'dbt compile -s orders', 'ls', 'git status']) await $.tool.call(bash(command))
  await clock.settle()
  expect(estimates).toEqual([])
  expect(ran).toHaveLength(4)
})

test('another warehouse is told once, never held, and not asked again', async ($, on) => {
  const { clock, estimates, ran } = await start($, on, { fallback: { success: true, supported: false, adapter: 'snowflake' } })
  const first: any = await $.tool.call(bash('dbt run -s orders'))
  const second: any = await $.tool.call(bash('dbt run -s customers'))
  await clock.settle()

  expect(first.deny).toBeUndefined()
  expect(first.context).toEqual(['cost · no estimate on snowflake: only BigQuery has a dry run'])
  expect(second.deny).toBeUndefined()
  expect(estimates).toEqual(['orders'])
  expect(ran).toEqual(['dbt run -s orders', 'dbt run -s customers'])
})

test('an altimate-code without the tool shows one line saying what is needed, and the command runs', async ($, on) => {
  const { clock, ran } = await start($, on, { answers: { orders: 'unknown-tool' } })
  const result: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()

  expect(ran).toEqual(['dbt run -s orders'])
  expect(result.context).toHaveLength(1)
  expect(result.context[0]).toContain('needs a newer altimate-code')
})

test('a dry run that failed passes the command with the reason', async ($, on) => {
  const { clock, ran } = await start($, on, { answers: { orders: { success: false, error: 'Access Denied: BigQuery job' } } })
  const result: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()

  expect(ran).toEqual(['dbt run -s orders'])
  expect(result.context).toEqual(['cost · no estimate for orders: Access Denied: BigQuery job'])
})

test('/scan-cost estimates a model on demand and says how it stands against the limit', async ($, on) => {
  const { clock, estimates, ran } = await start($, on, { answers: { orders: OVER, customers: UNDER } })
  expect((await $.command.run({ command: 'scan-cost', args: 'orders' } as any)).text).toBe(
    'orders would scan 20.0 GiB, over the 10.0 GiB limit: a dbt run of it is held until /allow-scan.',
  )
  expect((await $.command.run({ command: 'scan-cost', args: 'customers' } as any)).text).toBe('customers would scan 2.0 GiB, within the 10.0 GiB limit.')
  expect((await $.command.run({ command: 'scan-cost', args: '' } as any)).text).toContain('Last estimate: customers')
  await clock.settle()
  expect(estimates).toEqual(['orders', 'customers'])
  expect(ran).toEqual([])
})

test('a command naming two models over the limit is held whole, and one /allow-scan lets all of it through once', async ($, on) => {
  const { clock, ran } = await start($, on, { answers: { orders: OVER, customers: bq(30 * GIB, '30.0 GiB') } })
  const command = 'dbt run -s orders && dbt run -s customers'
  expect(((await $.tool.call(bash(command))) as any).deny).toContain('30.0 GiB')
  await $.command.run({ command: 'allow-scan', args: '' } as any)
  const through: any = await $.tool.call(bash(command))
  await clock.settle()

  expect(through.deny).toBeUndefined()
  expect(through.context).toEqual([
    'cost · orders would scan 20.0 GiB, over the 10.0 GiB limit: allowed once',
    'cost · customers would scan 30.0 GiB, over the 10.0 GiB limit: allowed once',
  ])
  expect(ran).toEqual([command])
  expect(((await $.tool.call(bash(command))) as any).deny).toBeDefined()
})

test('/allow-scan with nothing held allows nothing', async ($, on) => {
  const { clock } = await start($, on, { answers: { orders: OVER } })
  expect((await $.command.run({ command: 'allow-scan', args: '' } as any)).text).toContain('Nothing is held')
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeDefined()
  await clock.settle()
})

test('the allowance is for the command that was held: another over-limit command is held, and the allowance is gone', async ($, on) => {
  const { clock, ran } = await start($, on, { answers: { orders: OVER, customers: OVER } })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeDefined()
  await $.command.run({ command: 'allow-scan', args: '' } as any)

  expect(((await $.tool.call(bash('dbt run -s customers'))) as any).deny).toBeDefined()
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeDefined()
  await clock.settle()
  expect(ran).toEqual([])
})

test('an estimate whose rounded size is within the limit but whose upper bound is over it is held', async ($, on) => {
  const { clock } = await start($, on, { answers: { orders: bq(10 * GIB, '10.0 GiB', 10 * GIB + 52 * 1024 ** 2) } })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toContain('10.0 GiB')
  await clock.settle()
})

test('a command that sets its own target, defer state, vars or project is not estimated', async ($, on) => {
  const { clock, estimates, ran } = await start($, on, { answers: { orders: OVER } })
  const commands = [
    'dbt run -s orders --target prod',
    'dbt run -s orders --defer --state prod-run',
    `dbt run -s orders --vars '{a: 1}'`,
    'dbt run -s orders --project-dir other',
    'DBT_PROFILES_DIR=ci dbt run -s orders',
    'cd other && dbt run -s orders',
    ' cd other && dbt run -s orders',
    'export DBT_TARGET=prod; dbt run -s orders',
    'uv run --directory other dbt run -s orders',
    "dbt run -s orders --'vars' x",
    'dbt run -s orders --full-refresh',
  ]
  for (const command of commands) {
    const result: any = await $.tool.call(bash(command))
    expect(result.deny).toBeUndefined()
    expect(result.context[0]).toContain('it sets its own target, defer state, vars, project or refresh mode')
  }
  await clock.settle()
  expect(estimates).toEqual([])
  expect(ran).toEqual(commands)
})

test('dbt show --inline with its SQL on the next line after a backslash is estimated', async ($, on) => {
  const { clock, estimates } = await start($, on, { answers: { 'select * from big': OVER } })
  const result: any = await $.tool.call(bash(`dbt show --inline \\\n  'select * from big'`))
  await clock.settle()
  expect(estimates).toEqual(['select * from big'])
  expect(result.deny).toContain('20.0 GiB')
})

test('letting a later command through clears the hold from the status line', async ($, on) => {
  const { clock, statuses } = await start($, on, { answers: { orders: OVER } })
  await $.tool.call(bash('dbt run -s orders'))
  await $.tool.call(bash('dbt run -s +orders'))
  await clock.settle()
  expect(statuses.filter(Boolean).at(-1)).not.toContain('held')
})

test('the lines under a command are the latest estimate of it, never an earlier one', async ($, on) => {
  const answers: Record<string, any> = { orders: UNDER }
  const { clock } = await start($, on, { answers })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).context).toEqual(['cost · orders would scan 2.0 GiB'])
  answers.orders = bq(3 * GIB, '3.0 GiB')
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).context).toEqual(['cost · orders would scan 3.0 GiB'])
  await clock.settle()
})

test('/allow-scan allows only the hold it read: a hold replaced meanwhile is not allowed', async ($, on) => {
  const { clock, ran } = await start($, on, { answers: { orders: OVER, customers: OVER } })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeDefined()
  const allowing = $.command.run({ command: 'allow-scan', args: '' } as any)
  expect(((await $.tool.call(bash('dbt run -s customers'))) as any).deny).toBeDefined()
  await allowing
  await clock.settle()
  // Whichever order the two steps took, customers (the later hold) is not allowed by a read of orders.
  expect(((await $.tool.call(bash('dbt run -s customers'))) as any).deny).toBeDefined()
  expect(ran).toEqual([])
})

test('a non-dbt command in between neither clears the hold nor spends the allowance', async ($, on) => {
  const { clock, ran } = await start($, on, { answers: { orders: OVER } })
  await $.tool.call(bash('dbt run -s orders'))
  await $.command.run({ command: 'allow-scan', args: '' } as any)
  await $.tool.call(bash('ls'))
  const through: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(through.deny).toBeUndefined()
  expect(ran).toEqual(['ls', 'dbt run -s orders'])
})

test('inlineSql reads the query as the shell would', () => {
  expect(inlineSql(`dbt show --inline "select 'a' as x"`)).toBe(`select 'a' as x`)
  expect(inlineSql(`dbt show --inline='select 1'`)).toBe('select 1')
  expect(inlineSql(`dbt show --inline select\\ 1 --limit 5`)).toBe('select 1')
  expect(inlineSql(`dbt show --inline \\\n 'select 1'`)).toBe('select 1')
  expect(inlineSql('dbt show -s orders')).toBeNull()
})

test('formatBytes writes the units the dry run does', () => {
  expect(formatBytes(512)).toBe('512.0 Bytes')
  expect(formatBytes(1536)).toBe('1.5 KiB')
  expect(formatBytes(10 * GIB)).toBe('10.0 GiB')
  expect(formatBytes(1024 ** 5)).toBe('1.0 PiB')
})
