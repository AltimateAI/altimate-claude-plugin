import { expect, test } from 'claude-code/testing'

import {
  attempt,
  featureBandLines,
  featuresBashAfter,
  featuresBashGate,
  featuresBashRewrite,
  featuresEditAfter,
  featuresReadOrEditAfter,
  featuresSessionEnd,
  featuresSessionStart,
  featuresTurnComplete,
  featuresTurnStart,
} from './index'

const engine = () => {
  const logs: string[] = []
  // The state and command surface is the defer feature's, which is real: its settings are not read for a stub run.
  const kept = new Map<string, unknown>()
  const state = { get: async (key: string) => ({ value: kept.get(key), version: 0 }), set: async (key: string, value: unknown) => (kept.set(key, value), { isSet: true, version: 1 }) }
  return {
    logs,
    $: {
      ui: { log: (text: string) => void logs.push(text), status: () => {} },
      command: { register: async () => {} },
      state,
      session: { root: async () => null },
      clock: { now: async () => 0 },
    } as any,
  }
}

test('attempt logs a feature function that throws at once, one that rejects, and passes a value on', async () => {
  const { $, logs } = engine()
  // Each phase wraps the call in attempt, so a function that throws before it returns a promise
  // (not an async function) is caught like a rejection.
  const syncThrow = (): Promise<string> => {
    throw new Error('at once')
  }
  expect(await attempt($, 'runs', 'sessionStart', syncThrow)).toBeUndefined()
  expect(await attempt($, 'defer', 'bandLine', async () => Promise.reject(new Error('later')))).toBeUndefined()
  expect(await attempt($, 'cost', 'bashGate', () => ({ deny: 'no' }))).toEqual({ deny: 'no' })
  expect(await attempt($, 'docs', 'bashRewrite', async () => 'dbt run')).toBe('dbt run')
  expect(logs).toEqual(['runs · sessionStart failed: Error: at once', 'defer · bandLine failed: Error: later'])
})

test('with every feature a stub, each phase runs through the features and logs nothing', async () => {
  const { $, logs } = engine()
  const bash = { tool: 'Bash', command: 'dbt run -s a' } as any
  const file = { tool: 'Edit', file_path: '/repo/models/a.sql' } as any
  await featuresSessionStart($, {} as any)
  await featuresTurnStart($, {} as any)
  await featuresTurnComplete($, {} as any, {} as any)
  await featuresSessionEnd($, {} as any)
  expect(await featureBandLines($, {} as any)).toEqual([])
  expect(await featuresBashRewrite($, bash)).toBe('dbt run -s a')
  expect(await featuresBashGate($, bash)).toBeNull()
  expect(await featuresBashAfter($, bash, {} as any)).toEqual([])
  expect(await featuresEditAfter($, file, {} as any, { path: '/repo/models/a.sql', before: null })).toEqual([])
  expect(await featuresReadOrEditAfter($, file, {} as any, { path: '/repo/models/a.sql' })).toEqual([])
  expect(logs).toEqual([])
})
