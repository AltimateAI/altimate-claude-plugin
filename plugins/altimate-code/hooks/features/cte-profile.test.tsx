import { expect, mock, test } from 'claude-code/testing'

import type { CteRow } from '../../types'
import { classifyTiers, slowestFirst, summaryOf, withTiers } from './cte-profile'

const PANE = {
  plugin: 'altimate-code',
  component: 'Pane',
  requestId: 'altimate-cte-profile',
  props: { title: 'Profile CTEs', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const row = (name: string, extra: Partial<CteRow> = {}): CteRow => ({ name, line: 1, clause: 0, status: 'done', ...extra })

test('tiers: hot from half the largest marginal time, warm from a fifth, all cool when nothing took time', () => {
  expect(classifyTiers([100, 50, 49, 20, 19, 0])).toEqual(['hot', 'hot', 'warm', 'warm', 'cool', 'cool'])
  expect(classifyTiers([0, 0])).toEqual(['cool', 'cool'])
  expect(classifyTiers([])).toEqual([])
})

test('marginal time is the time over the CTE before it in the same WITH clause, never negative', () => {
  const rows = withTiers([
    row('a', { queryMs: 100 }),
    row('b', { queryMs: 350 }),
    row('c', { queryMs: 300 }),
    row('d', { queryMs: 40, clause: 99 }),
    row('e', { status: 'pending' }),
  ])
  expect(rows.map(one => one.marginalMs)).toEqual([100, 250, 0, 40, undefined])
  expect(rows.map(one => one.tier)).toEqual(['warm', 'hot', 'cool', 'cool', undefined])
  expect(slowestFirst(rows).map(one => one.name)).toEqual(['b', 'a', 'd', 'c', 'e'])
})

test('the summary for Claude lists timed CTEs slowest first and names the failed ones', () => {
  const text = summaryOf({
    model: 'customers',
    status: 'stopped',
    rows: withTiers([row('a', { queryMs: 100, rows: 7 }), row('b', { queryMs: 400, rows: 3 }), row('c', { status: 'failed', error: 'boom' }), row('d', { status: 'pending' })]),
  })
  const lines = text.split('\n')
  expect(lines[0]).toContain('customers (stopped, 1 CTE not timed)')
  expect(lines[1]).toContain('- b (line 1): +300 ms (hot)')
  expect(lines[2]).toContain('- a (line 1): +100 ms (warm)')
  expect(text).toContain('- c (line 1): boom')
})

type Setup = { ctes?: string[]; hold?: { cte: string; until: Promise<void> }; times?: Record<string, number>; missing?: boolean }

async function start($: any, on: any, setup: Setup = {}) {
  const clock = mock.clock(on)
  const calls: { cte?: string; write: boolean }[] = []
  const toasts: string[] = []
  const ctes = setup.ctes ?? ['orders', 'payments', 'final']
  on('command.register', () => ({ value: { command: 'profile-ctes' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: {} }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($$: any, e: any) => {
    const { Box } = $$.ui.resolve(e)
    return <Box key="engine" />
  })
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    const [, command, , tool] = e.argv
    if (command !== 'tool' || tool !== 'dbt_cte_profile') return { value: { exitCode: 1, stdout: '', stderr: 'not this test' } }
    const args = JSON.parse(String(e.argv[e.argv.indexOf('--args') + 1] ?? '{}'))
    calls.push({ cte: args.cte, write: e.argv.includes('--allow-write') })
    const reply = (body: unknown, exitCode = 0) => ({ value: { exitCode, stdout: JSON.stringify(body), stderr: '' } })
    if (setup.missing) return reply({ status: 'error', output: `Unknown tool: ${tool}. Run \`altimate-code tool list\` to see the available tools.`, metadata: {} }, 1)
    if (!args.cte) return reply({ status: 'ok', output: '', metadata: { success: true, ctes: ctes.map((name, index) => ({ name, line: index + 2, index, clause: 0 })) } })
    if (setup.hold && setup.hold.cte === args.cte) await setup.hold.until
    return reply({ status: 'ok', output: '', metadata: { success: true, cte: args.cte, queryMs: setup.times?.[args.cte] ?? 10, rows: 5 } })
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const run = (args: string) => $.command.run({ command: 'profile-ctes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  return { clock, calls, toasts, run }
}

test('/profile-ctes lists the CTEs read-only, then times each with write permission, slowest first', async ($, on) => {
  const { clock, calls, toasts, run } = await start($, on, { times: { orders: 100, payments: 350, final: 380 } })
  const out = await run('customers')
  expect(out.text).toContain('Profiling the CTEs of customers')
  await clock.settle()

  expect(calls).toEqual([
    { cte: undefined, write: false },
    { cte: 'orders', write: true },
    { cte: 'payments', write: true },
    { cte: 'final', write: true },
  ])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map((one: any) => one.text as string)
  const order = ['payments', 'orders', 'final'].map(name => texts.findIndex(text => text.startsWith(name)))
  // payments adds 250 ms, orders 100, final 30: slowest first.
  expect(order.every(at => at >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(texts.find(text => text.startsWith('payments'))).toContain('+250 ms (hot)')
  expect(texts.find(text => text.startsWith('final'))).toContain('(cool)')
  expect(await ui.find({ key: 'cte-send' })).toBeDefined()
  expect(await ui.find({ key: 'cte-stop' })).toBeUndefined()
  expect(toasts.some(text => text.includes('slowest is payments'))).toBe(true)
  await ui.unmount()
})

test('the pane fills live and Stop ends the run between queries', async ($, on) => {
  let release!: () => void
  const until = new Promise<void>(resolve => (release = resolve))
  const { clock, calls, run } = await start($, on, { hold: { cte: 'payments', until } })
  await run('customers')
  await clock.settle()

  // orders is timed, payments is running (its query is held), final has not started.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(((await ui.find({ type: 'Text', text: /^orders/ })) as any)?.text).toContain('ms')
  expect(await ui.find({ type: 'Text', text: /Timing CTE 2 of 3/ })).toBeDefined()
  expect(await ui.find({ key: 'cte-stop' })).toBeDefined()
  expect(calls.map(call => call.cte)).toEqual([undefined, 'orders', 'payments'])

  await ui.press({ key: 'cte-stop' })
  await clock.settle()
  release()
  await clock.settle()

  // The query already running finished; the next was never sent.
  expect(calls.map(call => call.cte)).toEqual([undefined, 'orders', 'payments'])
  expect(await ui.find({ type: 'Text', text: /Stopped: 2 of 3 timed/ })).toBeDefined()
  expect(await ui.find({ key: 'cte-stop' })).toBeUndefined()
  await ui.unmount()
})

test('an altimate-code without the tool gets one line naming what is needed, and no query is sent', async ($, on) => {
  const { clock, calls, run } = await start($, on, { missing: true })
  await run('customers')
  await clock.settle()
  expect(calls).toEqual([{ cte: undefined, write: false }])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /needs a newer altimate-code/ })).toBeDefined()
  await ui.unmount()
})

test('without a model name and nothing read yet, the command asks for one and runs nothing', async ($, on) => {
  const { calls, run } = await start($, on)
  expect((await run('')).text).toContain('Name a model')
  expect(calls).toEqual([])
})
