import { expect, mock, test } from 'claude-code/testing'

import type { RunRecord } from '../../types'
import { fitStore, MAX_MESSAGE, MAX_ROWS, MAX_RUNS, resultsInvocation, summaryLine, toRecord, withRun } from './runs'

const ROOT = '/repo'

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-runs',
  props: { title: 'dbt runs', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const view = (invocationId: string | null, rows: [string, string, string | null][] = [['model.shop.stg_orders', 'success', null]], command = 'build') => ({
  found: true,
  invocationId,
  command,
  elapsedSec: 4.2,
  completedAt: '2026-11-13T10:00:00.000Z',
  results: rows.map(([uniqueId, status, message]) => ({ uniqueId, name: uniqueId.split('.').pop()!, status, executionTimeSec: 1.5, message })),
})

/** The session beneath the plugin: a store in memory, and the CLI answering `dbt_run_results` with `answer()`. */
async function start($: any, on: any, answer: () => unknown) {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  const filled: string[] = []
  const cli: string[] = []
  on('command.register', () => ({ value: { command: 'runs' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: stored.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    stored.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('mcp.connect', () => ({ value: { isConnected: false, reason: 'not_connected', message: 'off' } }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    if (e.argv[1] !== 'tool') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    cli.push(e.argv[3]!)
    return { value: { exitCode: 0, stdout: JSON.stringify({ status: 'ok', output: '', metadata: answer() }), stderr: '' } }
  })
  on('prompt.fill', (_: unknown, e: { text: string }) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.open', () => ({ value: {} }))
  on('tool.call', () => ({ result: { ok: true } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, stored, filled, cli }
}

test('a dbt build is recorded once; the same unchanged file is ignored; the line says what failed', async ($, on) => {
  const next = view('inv-1', [
    ['model.shop.stg_orders', 'success', null],
    ['model.shop.fct_sales', 'error', 'Database Error: column "x" does not exist'],
    ['test.shop.not_null_orders_id.f3a1c', 'pass', null],
  ])
  const { stored, cli } = await start($, on, () => next)

  const first: any = await $.tool.call({ tool: 'Bash', command: 'cd /repo && dbt build -s orders' })
  expect(first.context).toEqual(['build: 2 ok, 1 error: fct_sales'])
  const runs = (stored.get('runs') as Record<string, RunRecord[]>)[ROOT]!
  expect(runs.map(run => [run.id, run.commandLine, run.total, run.passed, run.failed])).toEqual([['inv-1', 'dbt build -s orders', 3, 2, 1]])
  expect(runs[0]!.rows[0]!.name).toBe('fct_sales')

  // Run again: dbt wrote nothing new (its invocation id is the one recorded).
  const again: any = await $.tool.call({ tool: 'Bash', command: 'dbt build -s orders' })
  expect(again.context ?? []).toEqual([])
  expect((stored.get('runs') as Record<string, RunRecord[]>)[ROOT]).toHaveLength(1)
  expect(cli).toEqual(['dbt_run_results', 'dbt_run_results'])
})

test('a Bash call that is no dbt command that writes results reads nothing', async ($, on) => {
  const { stored, cli } = await start($, on, () => view('inv-1'))
  await $.tool.call({ tool: 'Bash', command: 'ls models' })
  await $.tool.call({ tool: 'Bash', command: 'dbt deps' })
  expect(cli).toEqual([])
  expect(stored.has('runs')).toBe(false)
})

test('no run_results.json: nothing is recorded', async ($, on) => {
  const { stored } = await start($, on, () => ({ found: false, invocationId: null, command: null, elapsedSec: null, completedAt: null, results: [] }))
  const result: any = await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  expect(result.context ?? []).toEqual([])
  expect(stored.has('runs')).toBe(false)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: /runs lists the run, opens it with failures first, and Re-run fills the prompt`, async ($, on) => {
    const { filled } = await start($, on, () =>
      view('inv-9', [
        ['model.shop.stg_orders', 'success', null],
        ['model.shop.fct_sales', 'error', 'boom'],
      ]),
    )
    await $.tool.call({ tool: 'Bash', command: 'uv run dbt build -s fct_sales' })

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', text: /build .*1\/2 passed/ })).toBeDefined()
    await ui.press({ key: 'run-inv-9' })

    const rows = await ui.findAll({ type: 'Text', text: /^(error|success) / })
    expect(rows.map(row => row.text)).toEqual(['error fct_sales 1.5s', 'success stg_orders 1.5s'])

    await ui.press({ key: 'runs-rerun' })
    await ui.press({ key: 'runs-retry' })
    expect(filled).toEqual(['Run `uv run dbt build -s fct_sales`', 'Run `uv run dbt retry`'])
    await ui.unmount()
  })
}

test('a run with no failure has no Re-run failed button', async ($, on) => {
  await start($, on, () => view('inv-2'))
  await $.tool.call({ tool: 'Bash', command: 'dbt run' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'run-inv-2' })
  expect(await ui.find({ key: 'runs-rerun' })).toBeDefined()
  expect(await ui.find({ key: 'runs-retry' })).toBeUndefined()
  await ui.unmount()
})

test('which dbt invocation wrote the results, and what to retry', () => {
  expect(resultsInvocation('cd a && dbt run -s x | tee log')).toEqual({ commandLine: 'dbt run -s x', retryLine: 'dbt retry' })
  expect(resultsInvocation('DBT_PROFILES_DIR=. dbt build')).toEqual({ commandLine: 'DBT_PROFILES_DIR=. dbt build', retryLine: 'dbt retry' })
  expect(resultsInvocation('dbt deps && dbt test')?.commandLine).toBe('dbt test')
  expect(resultsInvocation('dbt deps')).toBeNull()
  expect(resultsInvocation('echo "unclosed')).toBeNull()
})

test('a record keeps failures first, cuts long messages and rows; at most 50 runs, the same id never twice', () => {
  const long = 'x'.repeat(MAX_MESSAGE + 500)
  const many = Array.from({ length: MAX_ROWS + 20 }, (_, i): [string, string, string | null] => [`model.shop.m${i}`, i === MAX_ROWS + 10 ? 'error' : 'success', i === MAX_ROWS + 10 ? long : null])
  const run = toRecord(view('a', many), 'dbt run', 'dbt retry')!
  expect(run.rows).toHaveLength(MAX_ROWS)
  expect(run.total).toBe(MAX_ROWS + 20)
  expect(run.rows[0]!.status).toBe('error')
  expect(run.rows[0]!.message!.length).toBe(MAX_MESSAGE + 1)
  expect(toRecord({ ...view(null), completedAt: null }, 'dbt run', 'dbt retry')).toBeNull()
  expect(toRecord(view(null), 'dbt run', 'dbt retry')!.id).toBe('2026-11-13T10:00:00.000Z')

  let runs: RunRecord[] = []
  for (let i = 0; i < MAX_RUNS + 5; i++) runs = withRun(runs, { ...run, id: `r${i}` })
  expect(runs).toHaveLength(MAX_RUNS)
  expect(runs[0]!.id).toBe(`r${MAX_RUNS + 4}`)
  expect(withRun(runs, { ...run, id: 'r10' }).map(one => one.id).filter(id => id === 'r10')).toHaveLength(1)
})

test('the store is cut to its budget, the oldest run of the busiest project first', () => {
  const fat = (id: string): RunRecord => ({ ...toRecord(view(id), 'dbt run', 'dbt retry')!, rows: Array.from({ length: 100 }, (_, i) => ({ uniqueId: `u${i}`, name: 'n'.repeat(300), status: 'success', executionTimeSec: 1, message: null })) })
  const held = { '/a': Array.from({ length: 50 }, (_, i) => fat(`a${i}`)), '/b': [fat('b0')] }
  const fitted = fitStore(held)
  expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(2_500_000)
  expect(fitted['/b']).toHaveLength(1)
  expect(fitted['/a']![0]!.id).toBe('a0')
})

test('the line for Claude names five failures and counts the rest', () => {
  const rows = Array.from({ length: 7 }, (_, i): [string, string, string | null] => [`model.shop.m${i}`, 'error', null])
  expect(summaryLine(toRecord(view('a', [...rows, ['model.shop.ok', 'success', null], ['model.shop.s', 'skipped', null]]), 'dbt build', 'dbt retry')!)).toBe(
    'build: 1 ok, 7 errors: m0, m1, m2, m3, m4 and 2 more, 1 skipped',
  )
})
