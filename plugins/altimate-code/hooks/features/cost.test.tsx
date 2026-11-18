import { expect, mock, test } from 'claude-code/testing'

import { formatBytes, inlineSql } from './cost'

const ROOT = '/repo'
const GIB = 1024 ** 3

type Options = {
  /** What dbt_cost_estimate answers for a model or SQL, by model name or the SQL text. */
  answers?: Record<string, Record<string, unknown> | 'unknown-tool'>
  /** The adapter's answer for everything else. */
  fallback?: Record<string, unknown>
  /** Answers given in turn for a model, before `answers` applies again. */
  sequence?: Record<string, Record<string, unknown>[]>
  /** The CLI answers only once this resolves. */
  hold?: Promise<void>
  /** With `hold`: only the estimate of this model or SQL waits. */
  holdFor?: string
  /** Per model: that model's estimate answers only once its promise resolves. */
  holds?: Record<string, Promise<void>>
  /** The session's directory; changed mid-test to stand for a /cd. */
  cwd?: string
  /** Set after start: the session's directory is not answered until this resolves. */
  holdCwd?: Promise<void>
  /** Set after start: only this lookup of the session's directory (counted from 1, after it is set) is never answered. */
  stallNth?: { n: number; seen: number }
  /** Drawing the status line throws. */
  statusFails?: boolean
  /** The Bash tool runs this command only once this resolves. */
  holdBash?: { command: string; until: Promise<void> }
}

/** The session beneath the plugin, a CLI whose dbt_cost_estimate is scripted, and a Bash tool that records what ran. */
async function start($: any, on: any, options: Options = {}) {
  const clock = mock.clock(on)
  const estimates: string[] = []
  /** Estimates asked for, before any hold: one that has started and not yet answered is in here. */
  const started: string[] = []
  const ran: string[] = []
  const statuses: (string | undefined)[] = []
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.end', () => ({ sessionId: 'test' }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', async () => {
    await options.holdCwd
    if (options.stallNth && ++options.stallNth.seen === options.stallNth.n) await new Promise<void>(() => {})
    return { value: options.cwd ?? ROOT }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_: unknown, e: { text?: string }) => {
    if (options.statusFails) throw new Error('no status line')
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('fs.exists', () => ({ value: false }))
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    const [, command, , tool] = e.argv
    if (command !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    // Another feature's tool (runs asks dbt_run_results) has nothing to report here, and is not an estimate.
    if (tool !== 'dbt_cost_estimate') return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: { found: false } }), stderr: '' } }
    // The adapter starts the project's dbt: the call must carry write permission.
    expect(e.argv).toContain('--allow-write')
    const args = JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1] ?? '{}'))
    const key = String(args.model ?? args.sql)
    started.push(key)
    if (options.holds?.[key]) await options.holds[key]
    if (options.hold && (options.holdFor === undefined || options.holdFor === key)) await options.hold
    estimates.push(key)
    const answer = options.sequence?.[key]?.shift() ?? options.answers?.[key] ?? options.fallback
    if (answer === 'unknown-tool') {
      return { value: { exitCode: 1, stdout: JSON.stringify({ status: 'error', output: `Unknown tool: ${tool}. Run \`altimate-code tool list\` to see the available tools.`, metadata: {} }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: answer ?? { success: false, error: 'no answer scripted' } }), stderr: '' } }
  })
  // The Bash tool itself, beneath the plugin.
  on('tool.call', async (_: unknown, e: { tool: string; command?: string }) => {
    if (e.tool === 'Bash' && options.holdBash && options.holdBash.command === e.command) await options.holdBash.until
    if (e.tool === 'Bash') ran.push(String(e.command))
    // A call takes time: the runs feature beside this one reads one dbt call ending at the very moment another began as an overlap.
    await clock.advance(100)
    return { result: { text: 'ok', isError: false } }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, estimates, ran, statuses, started }
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

test('a BigQuery table name in backticks inside single quotes is estimated; a backtick outside them is not', async ($, on) => {
  const q = 'select * from `p.d.t`'
  const { clock, estimates } = await start($, on, { answers: { [q]: OVER } })
  const result: any = await $.tool.call(bash(`dbt show --inline '${q}'`))
  await clock.settle()
  expect(estimates).toEqual([q])
  expect(result.deny).toContain('20.0 GiB')
  const before = estimates.length
  await $.tool.call(bash('dbt show --inline "select 1" --threads `echo 4`'))
  await $.tool.call(bash('dbt show --inline "select `echo 1`"'))
  await clock.settle()
  expect(estimates.length).toBe(before)
})

test('a cd to another directory makes the no-dry-run verdict forgotten', async ($, on) => {
  const options: Options = { answers: { orders: NO_DRY_RUN } }
  const { clock } = await start($, on, options)
  const run = () => $.tool.call(bash('dbt run -s orders')) as Promise<any>
  expect((await run()).deny).toBeUndefined()
  options.answers = { orders: OVER }
  await $.tool.call(bash('cd ../bigquery-project'))
  await clock.settle()
  expect((await run()).deny).toContain('20.0 GiB')
})

test('/allow-scan lets the next held command through once, then the one after is held again', async ($, on) => {
  const { clock, estimates, ran, statuses } = await start($, on, { answers: { orders: OVER } })
  expect((await $.tool.call(bash('dbt run -s orders')) as any).deny).toBeDefined()
  expect(statuses.filter(Boolean).at(-1)).toContain('held')

  const allowed = await $.command.run({ command: 'allow-scan', args: '' } as any)
  expect(allowed.text).toContain('runs once')
  const through: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(through.deny).toBeUndefined()
  expect(through.context).toEqual(['cost · orders would scan 20.0 GiB, over the 10.0 GiB limit: allowed once'])
  expect(statuses.filter(Boolean).at(-1)).not.toContain('held')
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

test('a session folder that is never answered holds the gate for 80 ms at most: a command that scans nothing runs without waiting for the phase deadline', async ($, on) => {
  const options: Options = {}
  const { clock, ran } = await start($, on, options)
  let release: () => void = () => {}
  options.holdCwd = new Promise<void>(resolve => (release = resolve))
  const pending = $.tool.call(bash('git status'))
  await clock.advance(200)
  // A gate that waited for the folder would hold the call for the 5 s a phase has, and every gate after it with it.
  expect(ran).toEqual(['git status'])
  release()
  await clock.settle()
  const result: any = await pending
  expect(result.deny).toBeUndefined()
})

test('a session folder that could not be read is no project the gate knows: an earlier verdict is not reused for it', async ($, on) => {
  const options: Options = { answers: { orders: NO_DRY_RUN } }
  const { clock } = await start($, on, options)
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeUndefined()
  options.answers = { orders: OVER }
  options.holdCwd = new Promise<void>(() => {})
  const pending = $.tool.call(bash('dbt run -s orders'))
  for (let i = 0; i < 70; i++) await clock.advance(100)
  const result: any = await pending
  // Not allowed on the strength of the earlier verdict: the command is refused, to be asked again once the folder can be read.
  expect(result.deny).toBeDefined()
})

test('a session folder that cannot be read is an unknown project: no verdict is reused for it, and no estimate starts', async ($, on) => {
  const options: Options = { answers: { orders: NO_DRY_RUN } }
  const { clock, started } = await start($, on, options)
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeUndefined()
  options.answers = { orders: OVER }
  options.holdCwd = new Promise<void>(() => {})
  for (let again = 0; again < 2; again++) {
    const pending = $.tool.call(bash('dbt run -s orders')) as Promise<any>
    for (let i = 0; i < 70; i++) await clock.advance(100)
    // Refused, though the earlier answer was "no dry run here"; and nothing asks the adapter, which could start dbt in a project one is already running in.
    expect((await pending).deny).toContain('could not be read in time')
  }
  expect(started).toEqual(['orders'])
})

// The lookups the gate makes, one after another: whichever one is not answered, the project is not known and the command is refused.
for (const n of [2, 3, 4, 5, 6]) {
  test(`a scan is not let through on a project that cannot be told: the gate's lookup number ${n} of the session folder is not answered`, async ($, on) => {
    const options: Options = { answers: { orders: UNDER } }
    const { clock } = await start($, on, options)
    options.stallNth = { n, seen: 0 }
    const pending = $.tool.call(bash('dbt run -s orders')) as Promise<any>
    for (let i = 0; i < 70; i++) await clock.advance(100)
    expect(((await pending) as any).deny).toBeDefined()
  })
}

test('a lookup of the session folder lost on one model of a line is not made good by a later model that has no dry run', async ($, on) => {
  const options: Options = { answers: { first: UNDER, second: NO_DRY_RUN } }
  const { clock } = await start($, on, options)
  options.stallNth = { n: 3, seen: 0 }
  const pending = $.tool.call(bash('dbt run -s first && dbt run -s second')) as Promise<any>
  for (let i = 0; i < 70; i++) await clock.advance(100)
  expect(((await pending) as any).deny).toBeDefined()
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
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBe('up to 10.1 GiB (≈ 10.0 GiB estimated) would be scanned, over the 10.0 GiB limit. Narrow the query, or ask the user to run /allow-scan and then run the same command again.')
  await clock.settle()
})

test('an upper bound that formats the same as the limit is not reported as equal to it', async ($, on) => {
  const { clock } = await start($, on, { answers: { orders: bq(10 * GIB, '10.0 GiB', 10 * GIB + 30 * 1024 ** 2) } })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBe('just over 10.0 GiB would be scanned, over the 10.0 GiB limit. Narrow the query, or ask the user to run /allow-scan and then run the same command again.')
  await clock.settle()
})

test('a warehouse found to have no dry run ends a hold from before, and its allowance', async ($, on) => {
  const answers: Record<string, any> = { orders: OVER }
  const { clock, ran, statuses } = await start($, on, { answers })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeDefined()
  await $.command.run({ command: 'allow-scan', args: '' } as any)
  answers.orders = { success: true, supported: false, adapter: 'snowflake' }
  await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(ran).toEqual(['dbt run -s orders'])
  expect(statuses.at(-1) ?? '').not.toContain('held')
  expect((await $.command.run({ command: 'allow-scan', args: '' } as any)).text).toContain('Nothing is held')
})

test('a scan just over the limit reads as over it, not as equal to it', async ($, on) => {
  const { clock } = await start($, on, { answers: { orders: bq(10 * GIB + 1024 ** 2, '10.0 GiB') } })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBe('just over 10.0 GiB would be scanned, over the 10.0 GiB limit. Narrow the query, or ask the user to run /allow-scan and then run the same command again.')
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
    'dbt run -s orders stg_*',
    'dbt run -s orders --full-\\\nrefresh',
    'if true; then cd other; fi; dbt run -s orders',
    'dbt --profiles-dir ci run -s orders',
    'FOO=1 dbt run -s orders',
    "dbt run -s orders --threads $(printf '4 --target prod')",
    'dbt run -s orders --threads `echo 4 --vars x`',
    'dbt run -s orders 2>&${DBT_TARGET:=1}',
    'dbt --log-path "${DBT_TARGET:=prod}" deps; dbt run -s orders',
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
  const { clock, statuses } = await start($, on, { answers: { orders: OVER, customers: UNDER } })
  await $.tool.call(bash('dbt run -s orders'))
  await $.tool.call(bash('dbt run -s customers'))
  await clock.settle()
  expect(statuses.filter(Boolean).at(-1)).not.toContain('held')
})

test('a variant of the held command that is not estimated leaves the hold in place', async ($, on) => {
  const { clock, ran } = await start($, on, { answers: { orders: OVER } })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeDefined()
  await $.tool.call(bash('dbt run -s +orders'))
  await $.tool.call(bash('dbt run -s orders --full-refresh'))
  await clock.settle()
  await $.command.run({ command: 'allow-scan', args: '' } as any)
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeUndefined()
  expect(ran.at(-1)).toBe('dbt run -s orders')
})

test('a repeated --inline is estimated from the last one, as dbt reads it', async ($, on) => {
  const { clock, estimates } = await start($, on, { answers: { 'select * from big': OVER } })
  const result: any = await $.tool.call(bash(`dbt show --inline 'select 1' --inline 'select * from big'`))
  await clock.settle()
  expect(estimates).toEqual(['select * from big'])
  expect(result.deny).toContain('20.0 GiB')
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
  expect(inlineSql(`dbt show --inline 'select 1' --inline='select 2'`)).toBe('select 2')
  // The value of --inline is the query, even when it looks like an option.
  expect(inlineSql(`dbt show --inline '--inline=comment select 1'`)).toBe('--inline=comment select 1')
})

test('formatBytes writes the units the dry run does', () => {
  expect(formatBytes(512)).toBe('512.0 Bytes')
  expect(formatBytes(1536)).toBe('1.5 KiB')
  expect(formatBytes(10 * GIB)).toBe('10.0 GiB')
  expect(formatBytes(1024 ** 5)).toBe('1.0 PiB')
})

test('what leaves the query alone is still estimated: other dbt calls before it, thread and limit flags, a launcher', async ($, on) => {
  const { clock, estimates } = await start($, on, { answers: { orders: UNDER, 'select 1': UNDER } })
  for (const command of ['dbt deps && dbt run -s orders --threads 4', 'uv run dbt build --select orders --fail-fast', `dbt show --inline "select 1" --limit 5`]) {
    expect(((await $.tool.call(bash(command))) as any).context[0]).toContain('would scan 2.0 GiB')
  }
  await clock.settle()
  expect(estimates).toEqual(['orders', 'orders', 'select 1'])
})

test('a very long run of blank lines before the command costs no noticeable time', async ($, on) => {
  const { clock } = await start($, on, { answers: { orders: UNDER } })
  const began = Date.now()
  await $.tool.call(bash(`${'\n'.repeat(64000)}dbt run -s orders`))
  await clock.settle()
  expect(Date.now() - began).toBeLessThan(3000)
})

test('a line with a great many dbt calls is not read call by call', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, estimates } = await start($, on, { answers: { orders: UNDER } })
  const began = Date.now()
  const result: any = await $.tool.call(bash('dbt run -s orders;'.repeat(4000)))
  await clock.settle()
  expect(estimates).toEqual([])
  expect(result.context.length).toBe(6)
  expect(result.context[0]).toContain('cost · no estimate')
  expect(result.context[5]).toBe('cost · 3995 more notes not shown')
  // Other features' hooks (runs reads the same line) share this call, so the bound is for the whole chain.
  expect(Date.now() - began).toBeLessThan(10_000)
})

test('an estimate not done within the gate wait refuses the command, and the finished answer is used on the next try', async ($, on) => {
  let release!: () => void
  const { clock, estimates, ran } = await start($, on, { answers: { orders: OVER }, hold: new Promise<void>(resolve => (release = resolve)) })
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  expect(ran).toEqual([])

  release()
  await clock.settle()
  const second: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(second.deny).toContain('20.0 GiB')
  // One estimate served both passes.
  expect(estimates).toEqual(['orders'])
  expect(ran).toEqual([])
})

test('a held command stays held when its estimate cannot be made again, until /allow-scan', async ($, on) => {
  const answers: Record<string, any> = { orders: OVER }
  const { clock, ran } = await start($, on, { answers })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toContain('20.0 GiB')

  answers.orders = { success: false, error: 'Access Denied' }
  const again: any = await $.tool.call(bash('dbt run -s orders'))
  expect(again.deny).toContain('20.0 GiB')
  expect(ran).toEqual([])

  await $.command.run({ command: 'allow-scan', args: '' } as any)
  const through: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(through.deny).toBeUndefined()
  expect(ran).toEqual(['dbt run -s orders'])
})

test('an estimate still running spends no allowance: the held command stays held until every estimate is in', async ($, on) => {
  const options: Options = { answers: { a: OVER, b: OVER } }
  const { clock, ran } = await start($, on, options)
  const both = 'dbt run -s a && dbt run -s b'
  expect(((await $.tool.call(bash(both))) as any).deny).toContain('20.0 GiB')
  await $.command.run({ command: 'allow-scan', args: '' } as any)

  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'b'
  const slow = $.tool.call(bash(both))
  await clock.advance(4_001)
  expect(((await slow) as any).deny).toContain('still being estimated')
  expect(ran).toEqual([])

  // The allowance was not spent by the refusal: once b's estimate is in, the command goes through once.
  release()
  await clock.settle()
  const through: any = await $.tool.call(bash(both))
  await clock.settle()
  expect(through.deny).toBeUndefined()
  expect(ran).toEqual([both])
})

test('a command being retried keeps its finished answers however long the later estimate took', async ($, on) => {
  const options: Options = { answers: { a: UNDER, b: UNDER } }
  const { clock, estimates } = await start($, on, options)
  const both = 'dbt run -s a && dbt run -s b'
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'b'
  const first = $.tool.call(bash(both))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  // b takes longer than the answer for a is kept for a command nobody retries.
  const waiting = [] as any[]
  for (let i = 0; i < 7; i++) {
    await clock.advance(10_000)
    const again = $.tool.call(bash(both))
    await clock.advance(4_001)
    waiting.push((await again) as any)
  }
  expect(waiting.every(w => w.deny.includes('still being estimated'))).toBe(true)
  release()
  await clock.settle()
  options.hold = undefined
  const retry: any = await $.tool.call(bash(both))
  await clock.settle()
  expect(retry.deny).toBeUndefined()
  expect(estimates).toEqual(['a', 'b'])
})

test('an answer nobody took is not used a minute later: the model may have changed', async ($, on) => {
  const options: Options = { answers: { orders: OVER } }
  const { clock, estimates, ran } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()

  await clock.advance(61_000)
  options.answers = { orders: UNDER }
  const later: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(later.deny).toBeUndefined()
  expect(estimates).toEqual(['orders', 'orders'])
  expect(ran).toEqual(['dbt run -s orders'])
})

test('the same model named twice on a line is estimated once, so a slow estimate does not refuse the retry forever', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates, ran } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const line = 'dbt run -s orders && dbt show -s orders'
  const first = $.tool.call(bash(line))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  options.hold = undefined
  const retry: any = await $.tool.call(bash(line))
  await clock.settle()
  expect(retry.deny).toBeUndefined()
  expect(estimates).toEqual(['orders'])
  expect(ran).toEqual([line])
})

test('once the wait is spent no further estimate starts, so two adapters never start in one project at once', async ($, on) => {
  const options: Options = { answers: { a: UNDER, b: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s a && dbt run -s b'))
  await clock.advance(4_001)
  const denied: any = await first
  expect(denied.deny).toContain('The scan of a, b is still being estimated')
  release()
  await clock.settle()
  // b was never started: only one adapter start runs at a time.
  expect(estimates).toEqual(['a'])
})

test('a model named twice on a line is listed once as still being estimated', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders && dbt show -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('The scan of orders is still being estimated')
  release()
  await clock.settle()
})

test('a compound command gets every answer over its retries, however long each estimate takes', async ($, on) => {
  const options: Options = { answers: { a: UNDER, b: UNDER, c: UNDER } }
  const { clock, estimates, ran } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'c'
  const all = 'dbt run -s a && dbt run -s b && dbt run -s c'
  const first = $.tool.call(bash(all))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  const through: any = await $.tool.call(bash(all))
  await clock.settle()
  expect(through.deny).toBeUndefined()
  // a and b were asked for once: the retry used their answers.
  expect(estimates.filter(key => key === 'a')).toEqual(['a'])
  expect(ran).toEqual([all])
})

const EDIT = { tool: 'Edit', file_path: '/repo/models/orders.sql', old_string: '1', new_string: '2' } as any
const NO_DRY_RUN = { success: true, supported: false, adapter: 'duckdb' }

test('an edit made while an estimate is running makes its answer void: the command is asked about again', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates, ran } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(1_000)
  await $.tool.call(EDIT)
  options.answers = { orders: OVER }
  release()
  await clock.settle()
  expect(((await first) as any).deny).toContain('The project changed while the scan was being estimated')
  expect(ran).toEqual([])

  options.hold = undefined
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
  expect(estimates).toEqual(['orders', 'orders'])
})

test('a shell command that can rewrite the model drops the estimates made before it', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates, ran } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()

  await $.tool.call(bash('git restore models/orders.sql'))
  options.hold = undefined
  options.answers = { orders: OVER }
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
  expect(ran).toEqual(['git restore models/orders.sql'])
  expect(estimates).toEqual(['orders', 'orders'])
})

test('a read-only shell command keeps the answer waiting for the retry', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  await $.tool.call(bash('ls models'))
  options.hold = undefined
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toBeUndefined()
  expect(estimates).toEqual(['orders'])
})

test('a cd drops the answer waiting for the retry: it may have selected another project', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  await $.tool.call(bash('cd ../project-b'))
  options.hold = undefined
  options.answers = { orders: OVER }
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
  expect(estimates).toEqual(['orders', 'orders'])
})

test('a dbt run that has finished drops the estimates made before it', async ($, on) => {
  const options: Options = { answers: { orders: UNDER, customers: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  options.hold = undefined
  await $.tool.call(bash('dbt run -s customers'))
  await clock.settle()
  options.answers = { orders: OVER }
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
  expect(estimates.filter(e => e === 'orders').length).toBe(2)
})

test('a /cd to another project makes the no-dry-run verdict forgotten', async ($, on) => {
  const options: Options = { answers: { orders: NO_DRY_RUN } }
  const { clock } = await start($, on, options)
  const run = () => $.tool.call(bash('dbt run -s orders')) as Promise<any>
  expect((await run()).deny).toBeUndefined()
  options.answers = { orders: OVER }
  options.cwd = '/elsewhere/bigquery-project'
  await clock.settle()
  expect((await run()).deny).toContain('20.0 GiB')
})

test('a /cd to another project drops the finished answer and the allowance', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  options.hold = undefined
  options.cwd = '/elsewhere/project-b'
  options.answers = { orders: OVER }
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
  expect(estimates).toEqual(['orders', 'orders'])
  await $.command.run({ command: 'allow-scan', args: '' } as any)
  options.cwd = '/elsewhere/project-c'
  const again: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(again.deny).toContain('20.0 GiB')
})

test('a dbt run that is let through drops the estimates kept from before it', async ($, on) => {
  const options: Options = { answers: { orders: UNDER, customers: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'orders'
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  options.hold = undefined
  // Another command's run is let through, and is still running (not yet after-phase) when orders is retried.
  let finish!: () => void
  options.holdBash = { command: 'dbt run -s customers', until: new Promise<void>(resolve => (finish = resolve)) }
  const customers = $.tool.call(bash('dbt run -s customers'))
  await clock.settle()
  options.answers = { orders: OVER }
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
  expect(estimates.filter(e => e === 'orders').length).toBe(2)
  finish()
  await customers
})

test('a second model waits for the estimate running in the project, and starts none while it runs', async ($, on) => {
  const options: Options = { answers: { a: UNDER, b: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'a'
  const first = $.tool.call(bash('dbt run -s a'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  const second = $.tool.call(bash('dbt run -s b'))
  await clock.advance(4_001)
  expect(((await second) as any).deny).toContain('still being estimated')
  expect(estimates).toEqual([])
  release()
  await clock.settle()
  expect(estimates).toEqual(['a'])
})

test('an edit that voids a running estimate does not let another start beside it', async ($, on) => {
  const options: Options = { answers: { a: UNDER, b: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'a'
  const first = $.tool.call(bash('dbt run -s a'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  await $.tool.call(bash('git restore models/a.sql'))
  const second = $.tool.call(bash('dbt run -s b'))
  await clock.advance(4_001)
  expect(((await second) as any).deny).toContain('still being estimated')
  expect(estimates).toEqual([])
  release()
  await clock.settle()
  options.hold = undefined
  const third: any = await $.tool.call(bash('dbt run -s b'))
  await clock.settle()
  expect(third.deny).toBeUndefined()
  expect(estimates).toEqual(['a', 'b'])
})


test('a run let through while an estimate is still running: the retry does not take that estimate\'s pre-run answer', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  // Not estimated (its own target), so it is let through at once and starts rebuilding.
  expect(((await $.tool.call(bash('dbt run -s customers --target prod'))) as any).deny).toBeUndefined()
  release()
  await clock.settle()
  options.hold = undefined
  options.answers = { orders: OVER }
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
  expect(estimates).toEqual(['orders', 'orders'])
})

test('a voided running estimate is not reused and holds the next one back until it settles', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates, started } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  let finish!: () => void
  options.holdBash = { command: 'dbt run -s customers --target prod', until: new Promise<void>(resolve => (finish = resolve)) }
  // Still inside the gate's wait when the run is let through (and still running): nothing has timed it out yet.
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(1_000)
  const rebuild = $.tool.call(bash('dbt run -s customers --target prod'))
  await clock.advance(10)
  const again = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(500)
  expect(started).toEqual(['orders'])
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('The project changed while the scan was being estimated')
  expect(((await again) as any).deny).toContain('still being estimated')
  expect(started).toEqual(['orders'])
  finish()
  await rebuild
  release()
  await clock.settle()
  expect(estimates).toEqual(['orders'])
})

test('parallel dbt calls estimate one at a time: the second starts when the first is in', async ($, on) => {
  const options: Options = { answers: { a: UNDER, b: UNDER } }
  const { clock, started } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'a'
  const both = Promise.all([$.tool.call(bash('dbt run -s a')), $.tool.call(bash('dbt run -s b'))])
  await clock.advance(1_000)
  expect(started).toEqual(['a'])
  release()
  const results: any[] = await both
  await clock.settle()
  expect(started).toEqual(['a', 'b'])
  // The first run may finish while the second is being estimated, which moves the project on: then the second asks again.
  expect(results[0].deny).toBeUndefined()
  expect(results[1].deny === undefined || results[1].deny.includes('Run the same command again')).toBe(true)
})

test('/scan-cost does not start beside a running gate estimate', async ($, on) => {
  const options: Options = { answers: { a: UNDER, orders: UNDER } }
  const { clock, started } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'a'
  const gate = $.tool.call(bash('dbt run -s a'))
  await clock.advance(500)
  const scan = $.command.run({ command: 'scan-cost', args: 'orders' } as any)
  await clock.advance(1_000)
  expect(started).toEqual(['a'])
  release()
  await gate
  expect(((await scan) as any).text).toContain('orders would scan 2.0 GiB')
  expect(started).toEqual(['a', 'orders'])
})

test('a gate estimate does not start beside a running /scan-cost', async ($, on) => {
  const options: Options = { answers: { a: UNDER, orders: UNDER } }
  const { clock, started } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'orders'
  const scan = $.command.run({ command: 'scan-cost', args: 'orders' } as any)
  await clock.advance(500)
  const gate = $.tool.call(bash('dbt run -s a'))
  await clock.advance(1_000)
  expect(started).toEqual(['orders'])
  release()
  await scan
  expect(((await gate) as any).deny).toBeUndefined()
  await clock.settle()
  expect(started).toEqual(['orders', 'a'])
})

test('a /cd takes the old project\'s hold off the status line and forgets its last estimate', async ($, on) => {
  const options: Options = { answers: { orders: OVER } }
  const { clock, statuses } = await start($, on, options)
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toBeDefined()
  expect(statuses.filter(Boolean).at(-1)).toContain('held')
  options.cwd = '/elsewhere/project-b'
  await $.tool.call(bash('ls'))
  await clock.settle()
  expect(statuses.at(-1)).toBeUndefined()
  const allowed = await $.command.run({ command: 'allow-scan', args: '' } as any)
  expect(allowed.text).toContain('Nothing is held')
  const last = await $.command.run({ command: 'scan-cost', args: '' } as any)
  expect(last.text).toContain('Run /scan-cost <model>')
})

test('a quoted git option value is read: git -C "my repo" checkout . forgets the verdict', async ($, on) => {
  const options: Options = { answers: { orders: NO_DRY_RUN } }
  const { clock } = await start($, on, options)
  const run = () => $.tool.call(bash('dbt run -s orders')) as Promise<any>
  expect((await run()).deny).toBeUndefined()
  options.answers = { orders: OVER }
  await $.tool.call(bash('git -C "my repo" checkout .'))
  await clock.settle()
  expect((await run()).deny).toContain('20.0 GiB')
})

test('a lower bound already over the limit holds the command', async ($, on) => {
  const { clock } = await start($, on, { answers: { orders: { success: true, supported: true, adapter: 'bigquery', bytes: 20 * GIB, lowerBound: true, display: '20.0 GiB' } } })
  const result: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(result.deny).toContain('20.0 GiB')
})

test('a lower-bound-only estimate holds nothing and keeps an existing hold', async ($, on) => {
  const { clock } = await start($, on, { answers: { orders: OVER, cheap: { success: true, supported: true, adapter: 'bigquery', bytes: 0, lowerBound: true, display: '0 Bytes' } } })
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toContain('20.0 GiB')
  const result: any = await $.tool.call(bash('dbt run -s cheap'))
  await clock.settle()
  expect(result.context?.join(' ')).toContain('no estimate')
  expect(((await $.tool.call(bash('dbt run -s orders'))) as any).deny).toContain('20.0 GiB')
})

for (const restore of [
  'git -C /repo checkout .',
  'git -c core.fsmonitor=false restore .',
  'git --git-dir /x --work-tree /y reset --hard',
]) {
test(`${restore} makes the no-dry-run verdict forgotten`, async ($, on) => {
  const options: Options = { answers: { orders: NO_DRY_RUN } }
  const { clock } = await start($, on, options)
  const run = () => $.tool.call(bash('dbt run -s orders')) as Promise<any>
  expect((await run()).deny).toBeUndefined()
  options.answers = { orders: OVER }
  await $.tool.call(bash(restore))
  await clock.settle()
  expect((await run()).deny).toContain('20.0 GiB')
})
}

test('a warehouse found to have no dry run is asked about again after an edit, a profile change or ten minutes', async ($, on) => {
  const options: Options = { answers: { orders: NO_DRY_RUN } }
  const { clock, ran } = await start($, on, options)
  const run = () => $.tool.call(bash('dbt run -s orders')) as Promise<any>
  expect((await run()).deny).toBeUndefined()

  // The default target is now BigQuery: the next command is estimated and held.
  options.answers = { orders: OVER }
  expect((await run()).deny).toBeUndefined()
  await $.tool.call(EDIT)
  expect((await run()).deny).toContain('20.0 GiB')

  // The same by a shell command that names the profile.
  options.answers = { orders: NO_DRY_RUN }
  await $.command.run({ command: 'allow-scan', args: '' } as any)
  expect((await run()).deny).toBeUndefined()
  options.answers = { orders: OVER }
  await $.tool.call(bash('sed -i s/duckdb/bigquery/ profiles.yml'))
  expect((await run()).deny).toContain('20.0 GiB')

  // And by time alone.
  options.answers = { orders: NO_DRY_RUN }
  await $.command.run({ command: 'allow-scan', args: '' } as any)
  expect((await run()).deny).toBeUndefined()
  options.answers = { orders: OVER }
  await clock.advance(10 * 60_000 + 1)
  expect((await run()).deny).toContain('20.0 GiB')
  expect(ran.length).toBeGreaterThan(0)
})

test('a git read or a redirect to another stream does not drop the estimate the retry is waiting for', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  await $.tool.call(bash('git status'))
  await $.tool.call(bash('git diff --stat 2>&1'))
  await $.tool.call(bash('ls models 2>/dev/null'))
  options.hold = undefined
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toBeUndefined()
  expect(estimates).toEqual(['orders'])
})

test('a git restore that does not name the profile still makes the no-dry-run verdict forgotten', async ($, on) => {
  const options: Options = { answers: { orders: NO_DRY_RUN } }
  const { clock } = await start($, on, options)
  const run = () => $.tool.call(bash('dbt run -s orders')) as Promise<any>
  expect((await run()).deny).toBeUndefined()
  options.answers = { orders: OVER }
  await $.tool.call(bash('git checkout .'))
  await clock.settle()
  expect((await run()).deny).toContain('20.0 GiB')
})

test('a shell line that rewrites the model and also runs dbt voids the estimates made before it', async ($, on) => {
  const options: Options = { answers: { orders: UNDER, cheap: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'orders'
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()

  await $.tool.call(bash('git restore models/orders.sql && dbt run -s cheap'))
  await clock.settle()
  options.hold = undefined
  options.answers = { orders: OVER, cheap: UNDER }
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
  expect(estimates.filter(key => key === 'orders')).toEqual(['orders', 'orders'])
})

test('a command that is rewriting the model voids the estimates before it ends, not only after', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()

  // The rewrite is still running (its after-hook has not come) when the retry asks.
  let finish!: () => void
  options.holdBash = { command: 'sed -i s/a/b/ models/orders.sql; sleep 10', until: new Promise<void>(resolve => (finish = resolve)) }
  const rewrite = $.tool.call(bash('sed -i s/a/b/ models/orders.sql; sleep 10'))
  await clock.advance(1_000)
  options.hold = undefined
  options.answers = { orders: OVER }
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
  expect(estimates).toEqual(['orders', 'orders'])
  finish()
  await rewrite
})

test('a slow estimate for a line that also redirects its output is used on the retry, not asked for again', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates, ran } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const line = 'dbt run -s orders > run.log'
  const first = $.tool.call(bash(line))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  options.hold = undefined
  const retry: any = await $.tool.call(bash(line))
  await clock.settle()
  expect(retry.deny).toBeUndefined()
  expect(estimates).toEqual(['orders'])
  expect(ran).toEqual([line])
})

test('a no-dry-run answer that an edit made void is not kept as the warehouse', async ($, on) => {
  const options: Options = { answers: { orders: NO_DRY_RUN } }
  const { clock } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(1_000)
  await $.tool.call(EDIT)
  release()
  await clock.settle()
  expect(((await first) as any).deny).toContain('The project changed')
  options.hold = undefined
  options.answers = { orders: OVER }
  const retry: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(retry.deny).toContain('20.0 GiB')
})

test('a status line that cannot be drawn does not let a scan over the limit through', async ($, on) => {
  const { clock, ran } = await start($, on, { answers: { orders: OVER }, statusFails: true })
  const result: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(result.deny).toContain('20.0 GiB')
  expect(ran).toEqual([])
})

test('an edit drops the estimates made before it', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, estimates, ran } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(4_001)
  expect(((await first) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()

  options.answers = { orders: OVER }
  await $.tool.call({ tool: 'Edit', file_path: '/repo/models/orders.sql', old_string: '1', new_string: '2' } as any)
  await clock.settle()
  const later: any = await $.tool.call(bash('dbt run -s orders'))
  await clock.settle()
  expect(later.deny).toContain('20.0 GiB')
  expect(estimates).toEqual(['orders', 'orders'])
  expect(ran).toEqual([])
})

test('a pending estimate on another command does not carry /allow-scan over to it', async ($, on) => {
  const options: Options = { answers: { a: OVER, b: OVER, c: UNDER } }
  const { clock, ran } = await start($, on, options)
  expect(((await $.tool.call(bash('dbt run -s a'))) as any).deny).toContain('20.0 GiB')
  await $.command.run({ command: 'allow-scan', args: '' } as any)

  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'c'
  const other = 'dbt run -s b && dbt run -s c'
  const slow = $.tool.call(bash(other))
  await clock.advance(4_001)
  expect(((await slow) as any).deny).toContain('still being estimated')
  release()
  await clock.settle()
  const retry: any = await $.tool.call(bash(other))
  expect(retry.deny).toContain('20.0 GiB')
  expect(ran).toEqual([])
})

test('a /cd away and back does not forget the estimate still running in the project', async ($, on) => {
  const options: Options = { answers: { orders: UNDER, b: UNDER, c: UNDER } }
  const { clock, started } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'orders'
  const first = $.command.run({ command: 'scan-cost', args: 'orders' } as any)
  await clock.advance(500)
  // Another project is not held back by it.
  options.cwd = '/elsewhere/project-b'
  const other = $.command.run({ command: 'scan-cost', args: 'b' } as any)
  await clock.advance(500)
  expect(((await other) as any).text).toContain('b would scan 2.0 GiB')
  // Back in the first project, a second estimate waits its turn and gives up after the short wait.
  options.cwd = undefined
  const again = $.command.run({ command: 'scan-cost', args: 'c' } as any)
  await clock.advance(4_001)
  expect(((await again) as any).text).toContain('another estimate is still running in this project')
  expect(started).toEqual(['orders', 'b'])
  // The gate learns each project it passes through: a Bash pass in A, one in B (the /cd, while orders still runs), then back in A.
  await $.tool.call(bash('ls'))
  options.cwd = '/elsewhere/project-b'
  await $.tool.call(bash('ls'))
  options.cwd = undefined
  await $.tool.call(bash('ls'))
  const third = $.command.run({ command: 'scan-cost', args: 'd' } as any)
  await clock.advance(4_001)
  expect(((await third) as any).text).toContain('another estimate is still running in this project')
  expect(started).toEqual(['orders', 'b'])
  release()
  await first
})

test('a queued /scan-cost that wakes after a /cd runs under the project now in use, behind its running estimate', async ($, on) => {
  const options: Options = { answers: { orders: UNDER, b: UNDER, c: UNDER } }
  const { clock, started } = await start($, on, options)
  let releaseFirst!: () => void
  let release!: () => void
  options.holds = { orders: new Promise<void>(resolve => (releaseFirst = resolve)), b: new Promise<void>(resolve => (release = resolve)) }
  const first = $.command.run({ command: 'scan-cost', args: 'orders' } as any)
  await clock.advance(100)
  const queued = $.command.run({ command: 'scan-cost', args: 'c' } as any)
  await clock.advance(100)
  options.cwd = '/elsewhere/project-b'
  const inB = $.command.run({ command: 'scan-cost', args: 'b' } as any)
  await clock.advance(100)
  expect(started).toEqual(['orders', 'b'])
  // The first project's estimate ends: the queued one must not start beside project b's running estimate.
  releaseFirst()
  await first
  await clock.advance(1_000)
  expect(started).toEqual(['orders', 'b'])
  release()
  await inB
  expect(((await queued) as any).text).toContain('c would scan 2.0 GiB')
  expect(started).toEqual(['orders', 'b', 'c'])
  await first
})

test('a /cd while the gate waits for an estimate also drops the hold of the project left', async ($, on) => {
  const options: Options = { answers: { a: OVER, b: UNDER } }
  const { clock } = await start($, on, options)
  expect(((await $.tool.call(bash('dbt run -s a'))) as any).deny).toContain('20.0 GiB')
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'b'
  const call = $.tool.call(bash('dbt run -s b'))
  await clock.advance(500)
  options.cwd = '/elsewhere/project-b'
  release()
  expect(((await call) as any).deny).toContain('The project changed while the scan was being estimated')
  await clock.settle()
  expect(((await $.command.run({ command: 'allow-scan', args: '' } as any)) as any).text).toContain('Nothing is held')
})

test('a /cd while the gate waits for an estimate: its answer is of the project left, so the command is refused', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, started } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  options.holdFor = 'orders'
  const call = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(500)
  expect(started).toEqual(['orders'])
  options.cwd = '/elsewhere/project-b'
  release()
  const result: any = await call
  expect(result.deny).toContain('The project changed while the scan was being estimated')
})

test('a dbt run let through while the gate waits on its estimate voids that answer: the waiting command is not allowed on it', async ($, on) => {
  const options: Options = { answers: { orders: UNDER } }
  const { clock, ran } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  let finish!: () => void
  options.holdBash = { command: 'dbt run -s customers --target prod', until: new Promise<void>(resolve => (finish = resolve)) }
  const first = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(1_000)
  const rebuild = $.tool.call(bash('dbt run -s customers --target prod'))
  await clock.advance(10)
  release()
  await clock.advance(10)
  expect(((await first) as any).deny).toContain('The project changed while the scan was being estimated')
  finish()
  await rebuild
  expect(ran).toEqual(['dbt run -s customers --target prod'])
})

test('a parallel call whose estimate fails is held by the hold another call recorded meanwhile', async ($, on) => {
  const options: Options = { sequence: { orders: [OVER, { success: false, error: 'Access Denied' }] } }
  const { clock, ran, started } = await start($, on, options)
  let release!: () => void
  options.hold = new Promise<void>(resolve => (release = resolve))
  const first = $.tool.call(bash('dbt run -s orders'))
  const second = $.tool.call(bash('dbt run -s orders'))
  await clock.advance(500)
  release()
  await clock.advance(100)
  const results: any[] = [await first, await second]
  await clock.settle()
  // Both calls asked: the second got its own failing estimate, not the first one's answer.
  expect(started).toEqual(['orders', 'orders'])
  expect(results.every(r => typeof r?.deny === 'string')).toBe(true)
  expect(ran).toEqual([])
})
