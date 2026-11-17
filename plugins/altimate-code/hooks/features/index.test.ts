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
  return { logs, $: { ui: { log: (text: string) => void logs.push(text) } } as any }
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

test('with every feature but docs a stub, each phase runs through the features and only docs, which needs a real engine, logs', async () => {
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
  // docs is a real feature and reads the engine's state and file system, which this bare engine lacks.
  expect(logs.filter(line => !line.startsWith('docs · '))).toEqual([])
})
