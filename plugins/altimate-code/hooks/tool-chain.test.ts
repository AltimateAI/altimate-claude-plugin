import { expect, test } from 'claude-code/testing'

import { FEATURE_IDS } from './features'
import { STATUS_ORDER, statusLineOf } from './status-line'
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

test('through the plugin, a Bash call passes unchanged while every feature is a stub', async ($, on) => {
  const calls: any[] = []
  on('tool.call', (_: unknown, e: any) => {
    calls.push(e)
    return { result: { ok: true } }
  })
  const bash: any = await $.tool.call({ tool: 'Bash', command: 'dbt run -s orders' })
  expect(calls.map(one => one.command ?? one.tool)).toEqual(['dbt run -s orders'])
  expect(bash.context ?? []).toEqual([])
})
