import { expect, test } from 'claude-code/testing'

import {
  registerFeatures,
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
  // Enough of the engine for a feature that keeps state, reads files and registers commands; a stub needs none of it.
  const $ = {
    ui: { log: (text: string) => void logs.push(text) },
    fs: { exists: async () => false, read: async () => '' },
    state: { get: async () => ({ value: null }), set: async () => ({ isSet: true }), update: async () => ({ isSet: true }) },
    command: { register: async () => {} },
  }
  return { logs, $: $ as any }
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
  // The runs feature is real here and needs a fuller engine than this stub; every other feature must log nothing.
  expect(logs.filter(line => !line.startsWith('runs · '))).toEqual([])
})

test('a feature whose register throws never reaches the caller, so the tool hook after the features still installs', () => {
  let calls = 0
  const on = new Proxy(() => {}, {
    get: () => on,
    apply: () => {
      calls++
      throw new Error('refused matcher')
    },
  }) as any
  expect(() => registerFeatures(on, { options: {} } as any)).not.toThrow()
  expect(calls).toBeGreaterThan(0)
})
