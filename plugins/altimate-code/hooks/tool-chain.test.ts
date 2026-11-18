import { expect, mock, test } from 'claude-code/testing'

import { FEATURE_IDS } from './features'
import { register } from './integrations'
import { STATUS_ORDER, statusLineOf } from './status-line'
import { within } from './altimate-cli'
import { nothingToReport } from './inert-features'
import { afterCall, beforeCall, PHASES, type ChainSteps } from './tool-chain'

/** Steps that record each phase they run, in order. */
function recording(overrides: Partial<ChainSteps> = {}) {
  const seen: string[] = []
  const steps: ChainSteps = {
    bashRewrite: async e => (seen.push(`bashRewrite:${e.command}`), e.command),
    bashGate: async e => (seen.push(`bashGate:${e.command}`), null),
    bashAfter: async e => (seen.push(`bashAfter:${e.command}`), []),
    editAfter: async (e, _, file) => (seen.push(`editAfter:${e.tool}:${file.before}`), []),
    readOrEditAfter: async e => (seen.push(`readOrEditAfter:${e.tool}`), []),
    readBefore: async path => (seen.push(`readBefore:${path}`), 'select 1'),
    readsBefore: false,
    limit: async work => work.catch(() => null),
    log: text => void seen.push(`log:${text}`),
    ...overrides,
  }
  return { seen, steps }
}

const ok = { text: 'ok', isError: false } as any

test('a Bash call goes bashRewrite, bashGate, the call, bashAfter; the gate and the call see the rewrite', async () => {
  const { seen, steps } = recording({
    bashRewrite: async e => (seen.push(`bashRewrite:${e.command}`), `${e.command} --target dev`),
    bashAfter: async e => (seen.push(`bashAfter:${e.command}`), ['ran']),
  })
  const pre = await beforeCall({ tool: 'Bash', command: 'dbt run' } as any, steps)
  seen.push(`call:${(pre.e as any).command}`)
  const result: any = await afterCall(pre.e, { ...ok, context: ['own'] }, pre.before, steps)

  expect(PHASES).toEqual(['bashRewrite', 'bashGate', 'bashAfter', 'editAfter', 'readOrEditAfter'])
  expect(seen).toEqual(['bashRewrite:dbt run', 'bashGate:dbt run --target dev', 'call:dbt run --target dev', 'bashAfter:dbt run --target dev'])
  expect(result.context).toEqual(['own', 'ran'])
})

test('a gate that denies stops the call: no after-phase runs', async () => {
  const { seen, steps } = recording({ bashGate: async e => (seen.push(`bashGate:${e.command}`), { deny: 'over the limit' }) })
  const pre = await beforeCall({ tool: 'Bash', command: 'dbt build' } as any, steps)
  expect(pre.deny).toEqual({ deny: 'over the limit' })
  expect(seen).toEqual(['bashRewrite:dbt build', 'bashGate:dbt build'])
})

test('an edit runs editAfter then readOrEditAfter, with the text from before only when asked; a read runs only readOrEditAfter', async () => {
  const edit = { tool: 'Edit', file_path: '/repo/models/a.sql', old_string: '1', new_string: '2' } as any
  const asked = recording({ readsBefore: true })
  const pre = await beforeCall(edit, asked.steps)
  await afterCall(pre.e, ok, pre.before, asked.steps)
  expect(asked.seen).toEqual(['readBefore:/repo/models/a.sql', 'editAfter:Edit:select 1', 'readOrEditAfter:Edit'])

  const plain = recording()
  const again = await beforeCall(edit, plain.steps)
  await afterCall(again.e, ok, again.before, plain.steps)
  const read = { tool: 'Read', file_path: '/repo/models/a.sql' } as any
  await afterCall(read, ok, (await beforeCall(read, plain.steps)).before, plain.steps)
  expect(plain.seen).toEqual(['editAfter:Edit:null', 'readOrEditAfter:Edit', 'readOrEditAfter:Read'])
})

test('a failed or refused call runs no file phase; a Bash call that failed still runs bashAfter', async () => {
  const { seen, steps } = recording()
  await afterCall({ tool: 'Write', file_path: '/repo/x.sql', content: '' } as any, { text: 'no', isError: true } as any, null, steps)
  await afterCall({ tool: 'Edit', file_path: '/repo/x.sql' } as any, { deny: 'no' } as any, null, steps)
  await afterCall({ tool: 'Bash', command: 'dbt test' } as any, { text: 'exit 1', isError: true } as any, null, steps)
  expect(seen).toEqual(['bashAfter:dbt test'])
})

test('without context lines the result is passed on as it came', async () => {
  const { steps } = recording()
  const result = await afterCall({ tool: 'Bash', command: 'ls' } as any, ok, null, steps)
  expect(result).toBe(ok)
})

test('the features are listed in the stated order, and the status line joins its parts in it', () => {
  expect(FEATURE_IDS).toEqual(['runs', 'defer', 'toModel', 'comments', 'cost', 'health', 'sqlGraph', 'docs', 'cteProfile'])
  expect(STATUS_ORDER).toEqual(['integrations', ...FEATURE_IDS])
  // Parts join in that order whatever order they were set in; feature parts alone get the plugin's mark.
  expect(statusLineOf({ cost: '2 GB', integrations: '1 synced', runs: '3 runs' })).toBe('1 synced · 3 runs · 2 GB')
  expect(statusLineOf({ integrations: '1 synced' })).toBe('1 synced')
  expect(statusLineOf({ docs: '80% documented' })).toBe('⚡ Altimate · 80% documented')
  expect(statusLineOf({ integrations: '', runs: '' })).toBeUndefined()
})

test('through the plugin, a Bash call reaches the tool unchanged and its result comes back with no added context', async ($, on) => {
  // The session beneath has nothing to report, so no feature that is built holds a call or adds to one it has no reason to.
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => ({ value: { isStdoutTruncated: false, isStderrTruncated: false, ...(nothingToReport(e.argv) ?? { exitCode: 1, stdout: '', stderr: 'no CLI here' }) } }))
  const calls: any[] = []
  on('tool.call', (_: unknown, e: any) => {
    calls.push(e)
    return { result: { ok: true } }
  })
  // A dbt command may get a note from a feature that watches dbt (what a run would scan); a call no feature
  // watches gets nothing. Neither is held or changed.
  const dbt: any = await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders' })
  const plain: any = await $.tool.call({ tool: 'Bash', command: 'ls models' })
  expect(calls.map(one => one.command ?? one.tool)).toEqual(['dbt run -s orders', 'ls models'])
  expect(dbt.deny).toBeUndefined()
  expect(plain.deny).toBeUndefined()
  expect(plain.context ?? []).toEqual([])
})

test('the plugin registers the chain: one tool.call hook for Bash and the file tools, which runs the call it is given', async () => {
  const hooks: { event: string; matcher: any; handler: any }[] = []
  const on: any = (event: string, ...rest: any[]) => {
    hooks.push({ event, matcher: rest.length > 1 ? rest[0] : undefined, handler: rest[rest.length - 1] })
  }
  register(on, {} as any)
  const chains = hooks.filter(hook => hook.event === 'tool.call' && hook.matcher?.tool instanceof RegExp)
  expect(chains.length).toBe(1)
  const tool: RegExp = chains[0]!.matcher.tool
  expect(['Bash', 'Read', 'Edit', 'Write', 'MultiEdit'].every(name => tool.test(name))).toBe(true)
  expect(tool.test('Grep')).toBe(false)
  // With every feature a stub, the chain hands the call on unchanged and passes its result back.
  // The deadline never fires, so every phase reaches its stub and none is given up on.
  const seen: any[] = []
  const logged: string[] = []
  const $ = { fs: { read: async () => null }, clock: { after: () => {} }, ui: { log: (text: string) => void logged.push(text) } }
  const result = await chains[0]!.handler($, { tool: 'Bash', command: 'dbt run -s orders' }, async (e: any) => (seen.push(e), ok))
  expect(seen).toEqual([{ tool: 'Bash', command: 'dbt run -s orders' }])
  expect(result).toBe(ok)
  expect(logged.filter(text => text.startsWith('tool chain ·'))).toEqual([])
})

/** Phases bounded by a real `within` on a clock whose deadline passes at once, so the test is fast. */
const quick = { clock: { after: (_ms: number, run: () => void) => void Promise.resolve().then(run) } } as any
const never = () => new Promise<never>(() => {})

test('a phase that never settles is given up on: the call passes through unchanged and the timeout is logged', async () => {
  const { seen, steps } = recording({
    bashRewrite: never,
    bashGate: never,
    bashAfter: never,
    editAfter: never,
    readOrEditAfter: never,
    readBefore: never,
    readsBefore: true,
    limit: work => within(quick, 20, work),
  })
  const bash = { tool: 'Bash', command: 'dbt run -s a' } as any
  const pre = await beforeCall(bash, steps)
  expect(pre.e).toBe(bash)
  expect(pre.deny).toBeNull()
  const result = await afterCall(pre.e, ok, pre.before, steps)
  expect(result).toBe(ok)

  const edit = { tool: 'Edit', file_path: '/repo/models/a.sql' } as any
  const editPre = await beforeCall(edit, steps)
  expect(editPre.before).toBeNull()
  expect(await afterCall(edit, ok, null, steps)).toBe(ok)
  expect(seen).toEqual(
    ['bashRewrite', 'bashGate', 'bashAfter', 'readBefore', 'editAfter', 'readOrEditAfter'].map(
      phase => `log:tool chain · ${phase} did not finish within 5000 ms or failed: the call goes on unchanged`,
    ),
  )
})

test('a phase that throws at once is treated like one that timed out', async () => {
  const { steps } = recording({
    bashRewrite: (() => {
      throw new Error('at once')
    }) as any,
  })
  const pre = await beforeCall({ tool: 'Bash', command: 'dbt run' } as any, steps)
  expect((pre.e as any).command).toBe('dbt run')
})

test('a deadline or a logger that throws drops only that phase: the gate after it still runs', async () => {
  let limits = 0
  const { seen, steps } = recording({
    // The first phase's deadline throws, the way a missing clock would.
    limit: (async (work: Promise<unknown>) => {
      if (limits++ === 0) throw new Error('no clock')
      return work
    }) as any,
    log: () => {
      throw new Error('no log')
    },
    bashGate: async e => (seen.push(`bashGate:${e.command}`), { deny: 'refused' }),
  })
  const pre = await beforeCall({ tool: 'Bash', command: 'dbt run' } as any, steps)
  expect(pre.deny).toEqual({ deny: 'refused' })
  expect(seen).toEqual(['bashRewrite:dbt run', 'bashGate:dbt run'])
})
